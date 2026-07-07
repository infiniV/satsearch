"""SigLIP2 model wrapper (spec §5).

The real GPU backend (torch + transformers v5) is imported lazily inside `load_model`
so unit tests can drive `Model` with a fake backend without importing torch/CUDA.

Backend contract (duck-typed):
    dims: int, device: str, logit_scale: float, logit_bias: float
    encode_text(text: str) -> np.ndarray[float32] (dims,)   # UNnormalized ok
    encode_images(pils: list[PIL.Image]) -> np.ndarray[float32] (n, dims)  # UNnormalized ok
`Model` L2-normalizes outputs and owns calibration + the fingerprint.
"""

from __future__ import annotations

import io

import numpy as np

DEFAULT_CHECKPOINT = "google/siglip2-so400m-patch16-256"
DEFAULT_IMAGE_SIZE = 256
TOKENIZER_MAX_LENGTH = 64


def _l2(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    n = np.where(n == 0, 1.0, n)
    return x / n


class Model:
    def __init__(self, backend, fingerprint: str):
        self._b = backend
        self._fingerprint = fingerprint

    @property
    def fingerprint(self) -> str:
        return self._fingerprint

    @property
    def dims(self) -> int:
        return int(self._b.dims)

    @property
    def device(self) -> str:
        return str(self._b.device)

    def calibrate(self, cos):
        """cosine -> SigLIP sigmoid match probability."""
        cos = np.asarray(cos, dtype=np.float32)
        z = cos * float(self._b.logit_scale) + float(self._b.logit_bias)
        out = 1.0 / (1.0 + np.exp(-z))
        return float(out) if out.ndim == 0 else out

    def encode_text(self, text: str) -> np.ndarray:
        return _l2(self._b.encode_text(text))

    def encode_image(self, image_bytes: bytes) -> np.ndarray:
        from PIL import Image  # pillow is a core dep; safe to import here
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        return _l2(self._b.encode_images([img]))[0]

    def encode_images(self, pils) -> np.ndarray:
        return _l2(self._b.encode_images(pils))


# ---------------------------------------------------------------------------
# Real GPU backend — imported lazily. Not covered by unit tests (needs CUDA).
# ---------------------------------------------------------------------------
def load_model(checkpoint_id: str = DEFAULT_CHECKPOINT, device: str = "cuda") -> Model:  # pragma: no cover
    import torch
    import torchvision
    import transformers
    from transformers import AutoModel, AutoProcessor
    import PIL

    dtype = torch.float16 if device == "cuda" else torch.float32
    model = AutoModel.from_pretrained(
        checkpoint_id, dtype=dtype, attn_implementation="sdpa"
    ).to(device).eval()
    processor = AutoProcessor.from_pretrained(checkpoint_id)
    logit_scale = float(model.logit_scale.exp().item())
    logit_bias = float(model.logit_bias.item())
    # dims via a probe text embed
    with torch.no_grad():
        probe = processor(text=["a"], padding="max_length",
                          max_length=TOKENIZER_MAX_LENGTH, return_tensors="pt").to(device)
        # transformers v5: get_text_features returns BaseModelOutputWithPooling;
        # the pooled projected embedding is `.pooler_output`.
        feats = model.get_text_features(**probe).pooler_output
    dims = int(feats.shape[-1])

    from .fingerprint import fingerprint, model_spec
    try:
        revision = model.config._commit_hash or "unknown"
    except Exception:
        revision = "unknown"
    image_size = getattr(processor.image_processor, "size", {}).get("height", DEFAULT_IMAGE_SIZE)
    spec = model_spec(
        checkpoint_id=checkpoint_id,
        hf_revision=str(revision),
        image_size=int(image_size),
        transformers_version=transformers.__version__,
        torchvision_version=torchvision.__version__,
        pillow_version=PIL.__version__,
        tokenizer_max_length=TOKENIZER_MAX_LENGTH,
    )
    fp = fingerprint(spec)

    class _TorchBackend:
        dims = 0
        device = ""
        logit_scale = 0.0
        logit_bias = 0.0

        def encode_text(self, text: str) -> np.ndarray:
            with torch.no_grad():
                inp = processor(text=[text], padding="max_length",
                                max_length=TOKENIZER_MAX_LENGTH, truncation=True,
                                return_tensors="pt").to(device)
                out = model.get_text_features(**inp).pooler_output
            return out[0].float().cpu().numpy()

        def encode_images(self, pils) -> np.ndarray:
            with torch.no_grad():
                inp = processor(images=list(pils), return_tensors="pt").to(device)
                out = model.get_image_features(**inp).pooler_output
            return out.float().cpu().numpy()

    backend = _TorchBackend()
    backend.dims = dims
    backend.device = device
    backend.logit_scale = logit_scale
    backend.logit_bias = logit_bias
    return Model(backend=backend, fingerprint=fp)

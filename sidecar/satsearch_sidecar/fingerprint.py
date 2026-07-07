"""Model fingerprint — the compatibility spine (spec §5).

Two SigLIP2 checkpoints can share `dims` yet produce incompatible vector spaces
(so400m-256 vs so400m-384 are both 1152-d). Compatibility is therefore keyed on a
fingerprint over a canonical JSON object — including the *implementation* versions of
the preprocessing libs, because resize interpolation / tokenizer behaviour is
version-dependent (a bump silently shifts the vector space otherwise).
"""

import hashlib
import json

# Fields that define an embedding's vector space. Kept as a reference list so tests
# and the importer agree on what must be present.
MODEL_FINGERPRINT_FIELDS = [
    "checkpoint_id",
    "hf_revision",
    "image_size",
    "resize_mode",
    "norm_mean",
    "norm_std",
    "tokenizer_max_length",
    "pooling",
    "preprocessing_impl",
]


def fingerprint(spec: dict) -> str:
    """sha256 hex over the canonical (sorted, delimited) JSON of `spec`."""
    canon = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def model_spec(
    *,
    checkpoint_id: str,
    hf_revision: str,
    image_size: int,
    transformers_version: str,
    torchvision_version: str,
    pillow_version: str,
    resize_mode: str = "bilinear",
    norm_mean: tuple = (0.5, 0.5, 0.5),
    norm_std: tuple = (0.5, 0.5, 0.5),
    tokenizer_max_length: int = 64,
    pooling: str = "pooler_output",
) -> dict:
    """Build the canonical spec dict for a SigLIP2 checkpoint. `preprocessing_impl`
    pins the libs whose behaviour affects the produced vectors."""
    return {
        "checkpoint_id": checkpoint_id,
        "hf_revision": hf_revision,
        "image_size": image_size,
        "resize_mode": resize_mode,
        "norm_mean": list(norm_mean),
        "norm_std": list(norm_std),
        "tokenizer_max_length": tokenizer_max_length,
        "pooling": pooling,
        "preprocessing_impl": {
            "transformers": transformers_version,
            "torchvision": torchvision_version,
            "pillow": pillow_version,
        },
    }

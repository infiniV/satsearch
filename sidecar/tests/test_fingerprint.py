from satsearch_sidecar.fingerprint import fingerprint, model_spec


def test_stable_and_order_independent():
    a = fingerprint({"checkpoint_id": "x", "image_size": 256})
    b = fingerprint({"image_size": 256, "checkpoint_id": "x"})
    assert a == b
    assert len(a) == 64  # sha256 hex


def test_changes_with_preprocessing_impl():
    base = {"checkpoint_id": "x", "transformers": "5.13.0"}
    bumped = {"checkpoint_id": "x", "transformers": "5.14.0"}
    assert fingerprint(base) != fingerprint(bumped)


def test_changes_with_checkpoint_and_resolution():
    a = fingerprint({"checkpoint_id": "so400m-256", "image_size": 256})
    b = fingerprint({"checkpoint_id": "so400m-384", "image_size": 384})
    # different resolution → same dims (1152) but MUST differ
    assert a != b


def test_model_spec_includes_required_fields():
    spec = model_spec(
        checkpoint_id="google/siglip2-so400m-patch16-256",
        hf_revision="abc123",
        image_size=256,
        transformers_version="5.13.0",
        torchvision_version="0.26.0",
        pillow_version="12.3.0",
    )
    for key in ("checkpoint_id", "hf_revision", "image_size", "resize_mode",
                "norm_mean", "norm_std", "tokenizer_max_length", "pooling",
                "preprocessing_impl"):
        assert key in spec
    assert spec["preprocessing_impl"]["transformers"] == "5.13.0"

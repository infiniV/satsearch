import math

import numpy as np

from satsearch_sidecar.siglip import Model


class FakeBackend:
    dims = 8
    device = "cpu"
    logit_scale = 4.0
    logit_bias = -1.0

    def encode_text(self, text):
        v = np.arange(self.dims, dtype=np.float32) + (len(text) % 3)
        return v

    def encode_images(self, pils):
        return np.stack([np.arange(self.dims, dtype=np.float32) + i for i in range(len(pils))])


def make_model():
    return Model(backend=FakeBackend(), fingerprint="fp123")


def test_calibrate_matches_sigmoid():
    m = make_model()
    cos = np.array([0.0, 0.5, 1.0], dtype=np.float32)
    got = m.calibrate(cos)
    exp = 1.0 / (1.0 + np.exp(-(cos * 4.0 + -1.0)))
    assert np.allclose(got, exp, atol=1e-6)
    # scalar path
    assert abs(float(m.calibrate(1.0)) - 1.0 / (1.0 + math.exp(-(1.0 * 4.0 - 1.0)))) < 1e-6


def test_encode_text_l2_normalized():
    m = make_model()
    v = m.encode_text("hello")
    assert v.shape == (8,)
    assert abs(float(np.linalg.norm(v)) - 1.0) < 1e-5


def test_encode_images_normalized_rows():
    m = make_model()
    out = m.encode_images([object(), object(), object()])
    assert out.shape == (3, 8)
    norms = np.linalg.norm(out, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


def test_fingerprint_and_dims_exposed():
    m = make_model()
    assert m.fingerprint == "fp123"
    assert m.dims == 8
    assert m.device == "cpu"

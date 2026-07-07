from satsearch_sidecar.satimg_layout import GES_RE, GES_LAYOUT, parse_ges


def test_parse_ges_extracts_xfile_yfile_zfile():
    assert parse_ges("ges_370059_307655_20.jpg") == (370059, 307655, 20)


def test_parse_ges_rejects_non_ges():
    assert parse_ges("note.jpg") is None
    assert parse_ges("5/1/2.png") is None


def test_ges_layout_encodes_the_satimg_quirk():
    assert GES_LAYOUT.template == "ges_{x}_{y}_{zfile}.jpg"
    assert GES_LAYOUT.ext == "jpg"
    assert GES_LAYOUT.zOffset == 1
    assert GES_LAYOUT.yScheme == "tms"


def test_ges_re_is_importable_pattern():
    assert GES_RE.search("ges_1_2_20.jpg") is not None

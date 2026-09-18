# Asset preparation

`prepare_assets.py` builds everything the demo ships from one MRI case: the slice
stack, overlays, meshes and `app/case.json`. `verify_assets.py` checks the
shipped files against the source. Neither runs in CI.

## Source data

Download these two volumes from the TCIA collection linked in the top-level
README and put them in the repository root (they are gitignored):

- `vs_gk_1_t1_refT1.nii.gz`: T1 image
- `vs_gk_1_seg_refT1.nii.gz`: tumour mask

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r prep/requirements.txt
python3 prep/prepare_assets.py   # writes app/assets/, app/case.json, prep/verify.json
python3 prep/verify_assets.py    # exits non-zero on any failure
```

Then shrink the 3D scene (about 8.6 MB to 1.3 MB):

```bash
npm install @gltf-transform/core@4 @gltf-transform/functions@4 \
            @gltf-transform/extensions@4 meshoptimizer
node prep/optimize_scene.mjs app/assets/brain_tumor.glb app/assets/brain_tumor.glb
```

`prepare_assets.py` overwrites `app/case.json`, so edit the report text in its
`report_paras` list, not in `case.json`.

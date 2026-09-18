# Asset preparation

`prepare_assets.py` turns the source MRI into everything the demo ships:
the slice stack, the overlays, the meshes and `app/case.json`.
`verify_assets.py` re-derives the same numbers from the source and checks the
shipped files against them. Neither script runs in CI or in the browser.

## Source files

Both scripts read two NIfTI volumes from the repository root:

- `vs_gk_1_t1_refT1.nii.gz` — the T1 image
- `vs_gk_1_seg_refT1.nii.gz` — the tumour segmentation mask

They are gitignored (`*.nii.gz`) and are not part of a clone. Download them from
the TCIA collection named in the top-level `README.md` and place them in the
repository root before running anything here.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r prep/requirements.txt
```

## Run

```bash
python3 prep/prepare_assets.py     # writes app/assets/, app/case.json, prep/verify.json
python3 prep/verify_assets.py      # re-derives and checks; exits non-zero on any FAIL
```

`prepare_assets.py` rewrites `app/case.json` wholesale. Any hand edit to the
report wording lives in the `report_paras` list inside that script, so edit it
there rather than in `app/case.json`.

## The gltf-transform post-step

`prepare_assets.py` exports `app/assets/brain_tumor.glb` at roughly 8.6 MB. The
shipped file is the result of a second pass through `optimize_scene.mjs`, which
brings it to about 1.3 MB:

```bash
npm install @gltf-transform/core@4 @gltf-transform/functions@4 \
            @gltf-transform/extensions@4 meshoptimizer
node prep/optimize_scene.mjs app/assets/brain_tumor.glb app/assets/brain_tumor.glb
```

Run it after every regeneration, otherwise the repository gains several
megabytes. Its header comment explains why the simplify step must reach the head
mesh only: the tumour mesh carries the measurement and keeps every triangle.

`verify_assets.py` parses the GLB container directly rather than through
trimesh, because the compressed file uses `KHR_mesh_quantization`.

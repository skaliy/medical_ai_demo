# Asset preparation

`prepare_assets.py` builds everything the demo ships from one MRI scan and its
tumour mask: the slice stack, overlays, meshes and `app/case.json`.
`verify_assets.py` checks the shipped files against the source. Neither runs in CI.

## Source data

The scripts read a contrast-enhanced T1 image and its tumour mask as NIfTI files
(`.nii.gz`, gitignored), in LPS orientation on the same voxel grid. By default
they read `vs_gk_1_t1_refT1.nii.gz` and `vs_gk_1_seg_refT1.nii.gz` from the
repository root; `--image` and `--mask` point both scripts at other files.

The shipped demo uses subject 1 of the TCIA collection linked in the top-level
README. TCIA distributes it as DICOM. Convert it with the
[VS_Seg preprocessing scripts](https://github.com/KCL-BMEIS/VS_Seg/tree/master/preprocessing),
which write the T1 image and T1-space mask for subject 1 as
`vs_gk_t1_refT1.nii.gz` and `vs_gk_seg_refT1.nii.gz`. Rename them to the default
names above, or pass them with `--image` and `--mask`.

## Run

Install the Python packages into an isolated environment. With the built-in
`venv`, from the repository root:

```bash
python3 -m venv .venv && source .venv/bin/activate
```

If you use conda, activate your own environment instead. Then:

```bash
pip install -r prep/requirements.txt
python3 prep/prepare_assets.py   # writes app/assets/, app/case.json, prep/verify.json
# or, with your own files:
python3 prep/prepare_assets.py --image my_t1.nii.gz --mask my_seg.nii.gz
```

Shrink the 3D scene from several megabytes to about 1.4 MB (`--no-save` keeps
npm from writing a `package.json`; `node_modules/` is gitignored):

```bash
npm install --no-save @gltf-transform/core@4 @gltf-transform/functions@4 \
            @gltf-transform/extensions@4 meshoptimizer
node prep/optimize_scene.mjs app/assets/brain_tumor.glb app/assets/brain_tumor.glb
```

Then check the result, with the same `--image` and `--mask` if you used them:

```bash
python3 prep/verify_assets.py    # exits non-zero on any failure
```

`prepare_assets.py` overwrites `app/case.json`, which holds only values derived
from the scan: model paths, the slice stack and the volume. The report texts live
in `app/index.html`. For a new case, rewrite them there and change `CASE_ID` at
the top of `prepare_assets.py`.

"""Check the shipped demo files against the source MRI scan and tumour mask.

Re-derives slices, overlays, volume and laterality independently of
prepare_assets.py, checks them against app/case.json, the slice stack and both
models, and the files index.html loads; exits non-zero if any check fails.
"""
import argparse
import json
import re
import struct
from pathlib import Path

import nibabel as nib
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
DEFAULT_IMAGE = ROOT / "vs_gk_1_t1_refT1.nii.gz"
DEFAULT_MASK = ROOT / "vs_gk_1_seg_refT1.nii.gz"

# The app reads exactly these keys from case.json; anything else is stale.
CASE_KEYS = {
    "caseId": None,
    "models": {"withHead", "tumorOnly"},
    "stack": {"sliceUrl", "overlayUrl", "count", "best", "overlayRange"},
    "volume": {"exactMl", "display", "unit"},
}

results = []


def check(name, cond, detail=""):
    results.append(cond)
    print(f"{'PASS' if cond else 'FAIL'} {name} {detail}")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE,
                        help=f"T1 MRI as NIfTI (default: {DEFAULT_IMAGE.name} in the repository root)")
    parser.add_argument("--mask", type=Path, default=DEFAULT_MASK,
                        help=f"tumour mask as NIfTI, on the same grid as --image "
                             f"(default: {DEFAULT_MASK.name} in the repository root)")
    return parser.parse_args()


def expected_slice(sl, win):
    vmin, vmax = win
    return (np.clip((sl - vmin) / (vmax - vmin), 0, 1) * 255).astype(np.uint8)


def within_one(got, want):
    """Same shape, and no pixel more than one grey level apart."""
    return got.shape == want.shape and np.abs(got.astype(int) - want.astype(int)).max() <= 1


def expected_overlay(m2):
    """The filled mask and its one-pixel boundary."""
    filled = ndimage.binary_fill_holes(m2)
    boundary = m2 & ~ndimage.binary_erosion(m2)
    return filled, boundary


def overlay_matches(ov, m2):
    """Opaque outline == mask boundary, translucent fill == the rest of the filled mask."""
    filled, boundary = expected_overlay(m2)
    alpha = ov[..., 3]
    return (np.array_equal(alpha > 200, boundary)
            and np.array_equal((alpha > 10) & (alpha <= 200), filled & ~boundary))


def check_inputs(img, msk_img):
    check("affines identical", np.allclose(img.affine, msk_img.affine, atol=1e-6))
    check("shapes identical", img.shape == msk_img.shape)
    check("native orientation LPS (axial, +i=left)", "".join(nib.aff2axcodes(img.affine)) == "LPS")


def check_case_keys(case):
    keys = {k: (set(v) if isinstance(v, dict) else None) for k, v in case.items()}
    ok = keys == CASE_KEYS
    check("case.json has exactly the expected keys", ok, "" if ok else f"got {keys}")


def check_best_slice(stack, data, data_disp, mask, mask_disp, win):
    """The stack's best slice, shown in the inspect and reveal states."""
    k = stack["best"]
    check("shown slice inside mask range", bool(mask[:, :, k].any()))

    disp_shape = data_disp.shape[:2]  # rows x cols of the displayed slice
    got = np.asarray(Image.open(APP / (stack["sliceUrl"] % k)))
    check("best slice PNG size == scan in-plane size", got.shape == disp_shape, f"{got.shape} vs {disp_shape}")
    check("best slice PNG matches radiological re-derivation",
          within_one(got, expected_slice(data_disp[:, :, k], win)))
    check("best slice PNG is rotated, not native",
          not within_one(got, expected_slice(data[:, :, k], win)))

    ov = np.asarray(Image.open(APP / (stack["overlayUrl"] % k)))
    filled, boundary = expected_overlay(mask_disp[:, :, k])
    ov_alpha = ov[..., 3]
    check("best overlay size == scan in-plane size", ov.shape[:2] == disp_shape,
          f"{ov.shape[:2]} vs {disp_shape}")
    check("best overlay outline == mask boundary (radiological)", np.array_equal(ov_alpha > 200, boundary))
    check("best overlay fill == filled mask",
          np.array_equal((ov_alpha > 10) & (ov_alpha <= 200), filled & ~boundary))
    check("best overlay background transparent", (ov_alpha[~filled] == 0).all())


def check_stack(stack, data, data_disp, mask_disp, win):
    """Stack completeness, overlay placement, one more slice and every overlay by content."""
    n = stack["count"]
    lo, hi = stack["overlayRange"]
    check("stack count == volume slices", n == data.shape[2])
    missing = [kk for kk in range(n) if not (APP / (stack["sliceUrl"] % kk)).exists()]
    check("all slice PNGs exist", not missing, f"missing {missing[:5]}")
    want_ov = {kk for kk in range(n) if mask_disp[:, :, kk].any()}
    have_ov = {kk for kk in range(n) if (APP / (stack["overlayUrl"] % kk)).exists()}
    check("overlay files exist exactly where mask present", want_ov == have_ov)
    check("overlay range matches mask extent", (min(want_ov), max(want_ov)) == (lo, hi))

    kk = lo + 1
    got = np.asarray(Image.open(APP / (stack["sliceUrl"] % kk)))
    check("a stack slice matches re-derivation", within_one(got, expected_slice(data_disp[:, :, kk], win)))
    bad = [kk for kk in sorted(have_ov)
           if not overlay_matches(np.asarray(Image.open(APP / (stack["overlayUrl"] % kk))), mask_disp[:, :, kk])]
    check(f"every stack overlay ({len(have_ov)}) matches its mask", not bad, f"mismatch on {bad}" if bad else "")


def check_volume(volume, vol_ml):
    check("case.json exact volume", abs(volume["exactMl"] - round(vol_ml, 3)) < 1e-6,
          f"{volume['exactMl']} vs {round(vol_ml, 3)}")
    expect_display = f"{vol_ml:.2f}".replace(".", ",")
    check("case.json display volume rounded (Norwegian comma, 2 decimals)",
          volume["display"] == expect_display, f"{volume.get('display')!r} vs {expect_display!r}")
    check("case.json volume unit is cm³", volume["unit"] == "cm³", repr(volume.get("unit")))


def check_tumor_glb(path, mask, zooms, vol_ml):
    g = trimesh.load(path, force="mesh")
    check("glb watertight", bool(g.is_watertight))
    check("glb volume within 2% of voxel count", abs(abs(g.volume) / 1000.0 - vol_ml) / vol_ml < 0.02,
          f"{abs(g.volume)/1000.0:.3f} mL vs {vol_ml:.3f} mL")
    ext_mm = [(int(np.ptp(mask.any(axis=tuple(a)).nonzero()[0]) + 1) * zooms[i])
              for i, a in [(0, (1, 2)), (1, (0, 2)), (2, (0, 1))]]
    ext = g.bounds[1] - g.bounds[0]
    # model axes: x=-RASx (i-extent), y=RASz (k-extent), z=RASy (j-extent)
    check("glb bbox matches physical extents",
          abs(ext[0] - ext_mm[0]) < 3 and abs(ext[1] - ext_mm[2]) < 3 and abs(ext[2] - ext_mm[1]) < 3,
          f"model {np.round(ext,1).tolist()} mm vs physical {np.round(ext_mm,1).tolist()} mm")
    check("glb centered near origin", np.abs(g.centroid).max() < 1.0)


def glb_json(path):
    """The glTF JSON chunk of a GLB file.

    Parsed straight from the container: the shipped scene uses
    KHR_mesh_quantization, which trimesh does not load.
    """
    blob = path.read_bytes()
    magic, version, total = struct.unpack_from("<4sII", blob, 0)
    assert magic == b"glTF" and version == 2 and total == len(blob), "not a valid GLB 2.0 file"
    off = 12
    while off < len(blob):
        chunk_len, chunk_type = struct.unpack_from("<I4s", blob, off)
        off += 8
        if chunk_type == b"JSON":
            return json.loads(blob[off:off + chunk_len].decode("utf-8"))
        off += chunk_len
    raise AssertionError("no JSON chunk in GLB")


def materials_of(gltf, mesh_name):
    meshes = {m.get("name"): m for m in gltf.get("meshes", [])}
    materials = gltf.get("materials", [])
    return [materials[p["material"]]
            for p in meshes.get(mesh_name, {}).get("primitives", [])
            if "material" in p]


def check_scene_glb(rel):
    """brain_tumor.glb, the asset the 3D dialog shows first, after optimize_scene.mjs."""
    check("case.json names the withHead model", bool(isinstance(rel, str) and rel.strip()), repr(rel))
    path = APP / (rel or "assets/brain_tumor.glb")
    check("brain_tumor.glb exists", path.exists(), str(path))
    if not path.exists():
        return

    gltf = glb_json(path)
    mesh_names = sorted({m.get("name") for m in gltf.get("meshes", [])})
    # The dialog scene is three meshes in one shared frame: the translucent head,
    # the tumor at its measured position inside it, and the shown MRI slice as a
    # textured plane.
    for name in ("brain", "tumor", "slice"):
        check(f"brain_tumor.glb contains a '{name}' mesh", name in mesh_names, str(mesh_names))

    brain_mats = materials_of(gltf, "brain")
    # Without alphaMode BLEND a glTF material is OPAQUE, the baseColorFactor alpha
    # is ignored, and the head mesh hides the tumor the dialog is titled after.
    check("brain material is alphaMode BLEND",
          bool(brain_mats) and all(m.get("alphaMode") == "BLEND" for m in brain_mats),
          str([m.get("alphaMode") for m in brain_mats]))
    brain_alpha = [m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])[3]
                   for m in brain_mats]
    check("brain material is translucent (baseColorFactor alpha < 1)",
          bool(brain_alpha) and all(a < 1 for a in brain_alpha),
          str([round(a, 3) for a in brain_alpha]))

    slice_mats = materials_of(gltf, "slice")
    # MASK, not BLEND: the plane's transparent border is cut away rather than
    # blended, so it does not fog the head it sits inside.
    check("slice material is alphaMode MASK",
          bool(slice_mats) and all(m.get("alphaMode") == "MASK" for m in slice_mats),
          str([m.get("alphaMode") for m in slice_mats]))
    # Unlit, so the MRI greyscale is shown as captured rather than shaded.
    check("slice material is unlit",
          bool(slice_mats) and all("KHR_materials_unlit" in (m.get("extensions") or {})
                                   for m in slice_mats),
          str([sorted((m.get("extensions") or {})) for m in slice_mats]))
    check("KHR_materials_unlit and KHR_mesh_quantization are declared",
          {"KHR_materials_unlit", "KHR_mesh_quantization"} <= set(gltf.get("extensionsUsed", [])),
          str(gltf.get("extensionsUsed")))

    images = gltf.get("images", [])
    check("the slice texture is one embedded PNG",
          len(images) == 1 and images[0].get("mimeType") == "image/png",
          str([i.get("mimeType") for i in images]))


def check_index_assets():
    """Every file under assets/ that index.html loads through a src attribute exists."""
    html = (APP / "index.html").read_text(encoding="utf-8")
    refs = sorted(set(re.findall(r'\bsrc=["\'](?:\./)?(assets/[^"\']+)["\']', html)))
    check("index.html references files under assets/", bool(refs), str(refs))
    for rel in refs:
        check(f"referenced file exists: {rel}", (APP / rel).exists())


def check_laterality(img, data, mask, stack):
    """The tumor shows on the side of the image the radiological convention puts it."""
    cen_ras = (img.affine @ np.append(ndimage.center_of_mass(mask), 1))[:3]
    brain = data > 0.15 * np.percentile(data[data > 0], 98)
    bcen_vox = ndimage.center_of_mass(brain)
    bcen_ras = (img.affine @ np.append(bcen_vox, 1))[:3]
    patient_left = cen_ras[0] < bcen_ras[0]  # RAS: +x = patient right
    # Display columns run toward patient left (viewer left = patient right), so a
    # patient-left tumor must sit right of the head centre in the shown overlay.
    ov = np.asarray(Image.open(APP / (stack["overlayUrl"] % stack["best"])))
    cols = np.nonzero(ov[..., 3])[1]
    tumor_col = cols.mean() if cols.size else float("nan")
    head_col = bcen_vox[0]  # display column = native axis 0
    side, shown = ("left", "right") if patient_left else ("right", "left")
    check(f"patient-{side} tumor shows on the viewer's {shown} (radiological)",
          bool(cols.size) and (tumor_col > head_col) == patient_left,
          f"tumor x={cen_ras[0]:.1f} head x={bcen_ras[0]:.1f} mm; "
          f"overlay col={tumor_col:.0f} head col={head_col:.0f}")


def main():
    args = parse_args()
    img = nib.load(args.image)
    msk_img = nib.load(args.mask)
    data = img.get_fdata(dtype=np.float32)
    mask = np.asanyarray(msk_img.dataobj) > 0
    case = json.loads((APP / "case.json").read_text(encoding="utf-8"))

    check_inputs(img, msk_img)
    check_case_keys(case)

    # display orientation: radiological axial = swapaxes 0/1
    # rows -> P (top = anterior, eyes up), cols -> L (viewer left = patient right)
    data_disp = np.swapaxes(data, 0, 1)
    mask_disp = np.swapaxes(mask, 0, 1)
    # shared volume-wide intensity window
    sub = data[::2, ::2, ::2]
    win = np.percentile(sub, (0.5, 99.5))

    check_best_slice(case["stack"], data, data_disp, mask, mask_disp, win)
    check_stack(case["stack"], data, data_disp, mask_disp, win)

    zooms = np.array(img.header.get_zooms()[:3], float)
    vol_ml = int(mask.sum()) * float(np.prod(zooms)) / 1000.0
    check_volume(case["volume"], vol_ml)
    check_tumor_glb(APP / case["models"]["tumorOnly"], mask, zooms, vol_ml)
    check_scene_glb(case["models"].get("withHead"))
    check_index_assets()
    check_laterality(img, data, mask, case["stack"])

    print("\n%d/%d checks passed" % (sum(results), len(results)))
    raise SystemExit(0 if all(results) else 1)


if __name__ == "__main__":
    main()

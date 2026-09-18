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

img = nib.load(ROOT / "vs_gk_1_t1_refT1.nii.gz")
msk_img = nib.load(ROOT / "vs_gk_1_seg_refT1.nii.gz")
data = img.get_fdata(dtype=np.float32)
mask = np.asanyarray(msk_img.dataobj) > 0
case = json.loads((APP / "case.json").read_text(encoding="utf-8"))

ok = []


def check(name, cond, detail=""):
    ok.append(cond)
    print(f"{'PASS' if cond else 'FAIL'} {name} {detail}")


check("affines identical", np.allclose(img.affine, msk_img.affine, atol=1e-6))
check("shapes identical", img.shape == msk_img.shape)
check("native orientation LPS (axial, +i=left)", "".join(nib.aff2axcodes(img.affine)) == "LPS")

# display orientation: radiological axial = swapaxes 0/1
# rows -> P (top = anterior, eyes up), cols -> L (viewer left = patient right)
data_disp = np.swapaxes(data, 0, 1)
mask_disp = np.swapaxes(mask, 0, 1)

k = case["slice"]["index"]
check("shown slice inside mask range", bool(mask[:, :, k].any()))

# --- shared volume-wide intensity window ---
sub = data[::2, ::2, ::2]
vmin, vmax = np.percentile(sub, (0.5, 99.5))


def expect_img(sl):
    return (np.clip((sl - vmin) / (vmax - vmin), 0, 1) * 255).astype(np.uint8)


# --- best-slice single files, radiological orientation ---
got = np.asarray(Image.open(APP / case["assets"]["slice"]))
check("slice.png size 512x512", got.shape == (512, 512), str(got.shape))
check("slice.png matches radiological re-derivation",
      np.abs(got.astype(int) - expect_img(data_disp[:, :, k]).astype(int)).max() <= 1)
check("slice.png is rotated, not native",
      np.abs(got.astype(int) - expect_img(data[:, :, k]).astype(int)).max() > 1)


def overlay_expect(m2):
    filled = ndimage.binary_fill_holes(m2)
    boundary = m2 & ~ndimage.binary_erosion(m2)
    return filled, boundary


ov = np.asarray(Image.open(APP / case["assets"]["overlay"]))
filled, boundary = overlay_expect(mask_disp[:, :, k])
ov_alpha = ov[..., 3]
check("overlay size 512x512", ov.shape[:2] == (512, 512))
check("overlay outline == mask boundary (radiological)", np.array_equal(ov_alpha > 200, boundary))
check("overlay fill == filled mask", np.array_equal((ov_alpha > 10) & (ov_alpha <= 200), filled & ~boundary))
check("overlay background transparent", (ov_alpha[~filled] == 0).all())

# --- slice stack completeness + per-slice overlays ---
stack = case["stack"]
n = stack["count"]
lo, hi = stack["overlayRange"]
check("stack count == volume slices", n == data.shape[2])
missing = [kk for kk in range(n)
           if not (APP / (stack["sliceUrl"] % kk)).exists()]
check("all slice PNGs exist", not missing, f"missing {missing[:5]}")
want_ov = {kk for kk in range(n) if mask_disp[:, :, kk].any()}
have_ov = {kk for kk in range(n) if (APP / (stack["overlayUrl"] % kk)).exists()}
check("overlay files exist exactly where mask present", want_ov == have_ov)
check("overlay range matches mask extent", (min(want_ov), max(want_ov)) == (lo, hi))
kk2 = lo + 1
got2 = np.asarray(Image.open(APP / (stack["sliceUrl"] % kk2)))
check("a stack slice matches re-derivation",
      np.abs(got2.astype(int) - expect_img(data_disp[:, :, kk2]).astype(int)).max() <= 1)
ov2 = np.asarray(Image.open(APP / (stack["overlayUrl"] % kk2)))
f2, b2 = overlay_expect(mask_disp[:, :, kk2])
check("a stack overlay matches its mask", np.array_equal(ov2[..., 3] > 200, b2)
      and np.array_equal((ov2[..., 3] > 10) & (ov2[..., 3] <= 200), f2 & ~b2))

# --- volume from voxel count ---
zooms = np.array(img.header.get_zooms()[:3], float)
voxel_count = int(mask.sum())
vol_ml = voxel_count * float(np.prod(zooms)) / 1000.0
check("case.json exact volume", abs(case["volume"]["exactMl"] - round(vol_ml, 3)) < 1e-6,
      f"{case['volume']['exactMl']} vs {round(vol_ml, 3)}")
check("case.json display volume rounded (Norwegian comma, 2 decimals)",
      case["volume"]["display"] == f"{vol_ml:.2f}".replace(".", ","),
      f"{case['volume'].get('display')!r} vs {f'{vol_ml:.2f}'.replace('.', ',')!r}")
check("case.json volume unit is cm\u00b3", case["volume"]["unit"] == "cm\u00b3",
      repr(case["volume"].get("unit")))

# --- GLB ---
g = trimesh.load(APP / case["assets"]["mesh"], force="mesh")
check("glb watertight", bool(g.is_watertight))
check("glb volume within 2% of voxel count", abs(abs(g.volume) / 1000.0 - vol_ml) / vol_ml < 0.02,
      f"{abs(g.volume)/1000.0:.3f} mL vs {vol_ml:.3f} mL")
cen_vox = ndimage.center_of_mass(mask)
ext_mm = [(int(np.ptp(mask.any(axis=tuple(a)).nonzero()[0]) + 1) * zooms[i])
          for i, a in [(0, (1, 2)), (1, (0, 2)), (2, (0, 1))]]
ext = g.bounds[1] - g.bounds[0]
# model axes: x=-RASx (i-extent), y=RASz (k-extent), z=RASy (j-extent)
check("glb bbox matches physical extents",
      abs(ext[0] - ext_mm[0]) < 3 and abs(ext[1] - ext_mm[2]) < 3 and abs(ext[2] - ext_mm[1]) < 3,
      f"model {np.round(ext,1).tolist()} mm vs physical {np.round(ext_mm,1).tolist()} mm")
check("glb centered near origin", np.abs(g.centroid).max() < 1.0)

# --- report text grounding ---
# The shipped report text carries the "{volume}" placeholder instead of a literal
# number, so case.json stays the single source of the measurement. The app renders
# it as display + U+00A0 + unit; substitute the same way before checking.
raw_report = "\n".join(case["report"]["textNob"])
vol2 = f"{vol_ml:.2f}".replace(".", ",")
volume_text = f"{case['volume']['display']}\u00a0{case['volume']['unit']}"
expect_text = f"{vol2}\u00a0cm\u00b3"
rt = raw_report.replace("{volume}", volume_text)
check("report text uses the {volume} placeholder, not a literal number",
      "{volume}" in raw_report and vol2 not in raw_report)
check("report states conclusion volume (comma, cm\u00b3, nbsp)", f"Tumorvolum {expect_text}" in rt)
check("report gives KI-generated volume", f"KI-generert tumorvolum: {expect_text}" in rt)
check("report names diagnosis", "vestibularisschwannom" in rt.lower())
check("report mentions MR caput + CPA location", "MR caput" in rt and "cerebellopontine" in rt.lower())
# "R:" is the shipped radiology shorthand for the conclusion heading; the older
# prep output spelled it "Konklusjon:". Accept either.
check("report has a conclusion heading", any(
    para.strip() in ("R:", "Konklusjon:") for para in case["report"]["textNob"]))
for bad in ["symptom", "behandling", "prognos", "frisk", "normal"]:
    check(f"report has no claim '{bad}'", bad not in rt.lower())

# --- brain_tumor.glb: the asset the 3D dialog shows first ---
# Parsed straight from the GLB container: the shipped file uses
# KHR_mesh_quantization, which trimesh does not load.
bt_rel = case["assets"].get("brainTumor")
check("case.json names the brainTumor asset", bool(isinstance(bt_rel, str) and bt_rel.strip()),
      repr(bt_rel))
bt_path = APP / (bt_rel or "assets/brain_tumor.glb")
check("brain_tumor.glb exists", bt_path.exists(), str(bt_path))


def glb_json(path):
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


if bt_path.exists():
    gltf = glb_json(bt_path)
    meshes = {m.get("name"): m for m in gltf.get("meshes", [])}
    materials = gltf.get("materials", [])

    def mats_of(mesh_name):
        return [materials[p["material"]]
                for p in meshes.get(mesh_name, {}).get("primitives", [])
                if "material" in p]

    # The dialog scene is three meshes in one shared frame: the translucent head,
    # the tumor at its measured position inside it, and the shown MRI slice as a
    # textured plane.
    for name in ("brain", "tumor", "slice"):
        check(f"brain_tumor.glb contains a '{name}' mesh", name in meshes, str(sorted(meshes)))

    brain_mats = mats_of("brain")
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

    slice_mats = mats_of("slice")
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

# --- narration audio referenced by index.html ---
html = (APP / "index.html").read_text(encoding="utf-8")
mp3s = sorted(set(re.findall(r'src="([^"]+\.mp3)"', html)))
check("index.html references narration MP3 files", len(mp3s) == 2, str(mp3s))
for rel in mp3s:
    check(f"audio file exists: {rel}", (APP / rel).exists())

cen_ras = (img.affine @ np.append(cen_vox, 1))[:3]
brain = data > 0.15 * np.percentile(data[data > 0], 98)
bcen_ras = (img.affine @ np.append(ndimage.center_of_mass(brain), 1))[:3]
check("laterality: tumor left of brain centroid (RAS x)", cen_ras[0] < bcen_ras[0],
      f"tumor x={cen_ras[0]:.1f} brain x={bcen_ras[0]:.1f}")
# in radiological display the left-side tumor must land on the viewer's RIGHT:
disp_cen = np.array([cen_vox[1], cen_vox[0], cen_vox[2]])  # row=j(P), col=i(L)
check("tumor appears right-of-center in displayed image (cols->L)", disp_cen[1] > mask.shape[0] / 2,
      f"col={disp_cen[1]:.0f} vs mid={mask.shape[0] / 2}")

print("\n%d/%d checks passed" % (sum(ok), len(ok)))
raise SystemExit(0 if all(ok) else 1)

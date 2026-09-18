import json
from pathlib import Path

import nibabel as nib
import numpy as np
import trimesh
from scipy import ndimage
from skimage import measure

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
ASSETS = APP / "assets"
ASSETS.mkdir(parents=True, exist_ok=True)
SLICES = ASSETS / "slices"
SLICES.mkdir(exist_ok=True)

img = nib.load(ROOT / "vs_gk_1_t1_refT1.nii.gz")
msk_img = nib.load(ROOT / "vs_gk_1_seg_refT1.nii.gz")

assert img.shape == msk_img.shape, "image and mask shapes differ"
assert np.allclose(img.affine, msk_img.affine, atol=1e-6), "image and mask affines differ"
zooms = np.array(img.header.get_zooms()[:3], dtype=float)
voxvol_mm3 = float(np.prod(zooms))

data = img.get_fdata(dtype=np.float32)
mask = np.asanyarray(msk_img.dataobj) > 0
labels = np.unique(np.asanyarray(msk_img.dataobj))
assert set(labels.tolist()) <= {0, 1}, f"unexpected mask labels: {labels}"

# --- display orientation: radiological axial convention ---
# Native LPS: axis0 -> Left, axis1 -> Posterior. As a plain array image that
# puts the patient's right on top and the eyes (anterior) to the LEFT.
# Swapping axes 0/1 makes rows increase toward P (top = anterior, eyes up)
# and columns increase toward L (viewer left = patient right): the way a
# radiologist reads axial slices. Mesh building below keeps the native array.
data_disp = np.swapaxes(data, 0, 1)
mask_disp = np.swapaxes(mask, 0, 1)
assert nib.aff2axcodes(img.affine) == ("L", "P", "S")

# --- slice selection: largest axial cross-section (axis 2 = S, unaffected) ---
area = mask.sum(axis=(0, 1))
k = int(np.argmax(area))
print(f"chosen axial slice k={k}, area={int(area[k])} px")

# --- volume from full 3D mask: voxel count x voxel volume ---
voxel_count = int(mask.sum())
vol_ml = voxel_count * voxvol_mm3 / 1000.0
# One rounding for the whole demo: case.json is the single source of the number
# every screen shows, so the dialog and the report can never disagree.
vol_display = f"{vol_ml:.2f}".replace(".", ",")

# --- shared intensity window over the whole volume (no flicker while scrolling)
sub = data[::2, ::2, ::2]
win_lo, win_hi = np.percentile(sub, (0.5, 99.5))


def window(sl):
    g = np.clip((sl - win_lo) / (win_hi - win_lo), 0, 1)
    return (g * 255).astype(np.uint8)


def overlay_rgba(m2):
    from scipy import ndimage as ndi

    filled = ndi.binary_fill_holes(m2)
    rgba = np.zeros((*m2.shape, 4), dtype=np.uint8)
    rgba[..., :3] = (255, 45, 149)  # magenta
    rgba[..., 3] = (filled * 70).astype(np.uint8)
    boundary = m2 & ~ndi.binary_erosion(m2)
    rgba[boundary, 3] = 255
    return rgba


from PIL import Image

# --- full slice stack + per-slice overlays (radiological orientation) ---
n_slices = data_disp.shape[2]
mask_present = [bool(mask_disp[:, :, kk].any()) for kk in range(n_slices)]
overlay_idx = [i for i, p in enumerate(mask_present) if p]
for kk in range(n_slices):
    Image.fromarray(window(data_disp[:, :, kk]), mode="L").save(SLICES / f"slice_{kk:03d}.png")
    if mask_present[kk]:
        Image.fromarray(overlay_rgba(mask_disp[:, :, kk]), mode="RGBA").save(
            SLICES / f"overlay_{kk:03d}.png"
        )
print(f"wrote {n_slices} slices, overlays on {overlay_idx[0]}-{overlay_idx[-1]}")

# --- best-slice single files (inspect/reveal states) ---
Image.fromarray(window(data_disp[:, :, k]), mode="L").save(ASSETS / "slice.png")
Image.fromarray(overlay_rgba(mask_disp[:, :, k]), mode="RGBA").save(ASSETS / "overlay.png")

# --- meshes from the full 3D mask and the head, one shared frame ---
# Model frame: x = -RAS x (viewer left = patient right, radiological), y = RAS z
# (up), z = RAS y (anterior toward the camera). Every mesh below is placed in
# this ONE frame and then translated by the same head centre, so the tumor sits
# at its true position inside the head. (An earlier version centred each mesh on
# its own centroid, which drew the tumor in the middle of the head.)
def index_to_model(idx):
    hom = np.column_stack([idx, np.ones(len(idx))])
    ras = (img.affine @ hom.T).T[:, :3]
    return np.column_stack([-ras[:, 0], ras[:, 2], ras[:, 1]])


# tumor: marching cubes on the exact mask, no decimation (it carries the measurement)
verts, faces, normals, _ = measure.marching_cubes(mask.astype(np.float32), level=0.5)
tumor_model = index_to_model(verts)
tumor_mean = tumor_model.mean(axis=0)
mesh = trimesh.Trimesh(vertices=tumor_model - tumor_mean, faces=faces, process=True)
if mesh.volume < 0:
    mesh.invert()  # ensure outward-facing winding for GLB rendering
raw_vol_ml = abs(mesh.volume) / 1000.0
trimesh.smoothing.filter_taubin(mesh, iterations=8)
smooth_vol_ml = abs(mesh.volume) / 1000.0
TUMOR_RGBA = [224, 82, 150, 255]
mesh.visual.material = trimesh.visual.material.PBRMaterial(
    baseColorFactor=TUMOR_RGBA, main_color=TUMOR_RGBA
)
mesh.export(ASSETS / "tumor.glb")  # centred on its own mean: the tumor-only view

# --- head context: a clean outer shell of the head from the MRI volume ---
# Display context only; the tumor mesh remains the measured mask.
brain = data > 0.15 * np.percentile(data[data > 0], 98)
brain = ndimage.binary_fill_holes(brain)
brain = ndimage.binary_closing(brain, iterations=2)
labels_brain, n_brain = ndimage.label(brain)
if n_brain:
    counts = np.bincount(labels_brain.ravel())
    brain = labels_brain == int(np.argmax(counts[1:]) + 1)
# Resample to a 1 mm grid, fill and close so sinuses and ear canals do not leave
# noisy interior surfaces inside the translucent shell, keep the largest blob.
iso = ndimage.zoom(brain.astype(np.uint8), zooms, order=0).astype(bool)
iso = ndimage.binary_fill_holes(iso)
ball = ndimage.iterate_structure(ndimage.generate_binary_structure(3, 1), 3)
iso = ndimage.binary_closing(iso, structure=ball)
iso = ndimage.binary_fill_holes(iso)
labels_iso, n_iso = ndimage.label(iso)
if n_iso:
    counts = np.bincount(labels_iso.ravel())
    iso = labels_iso == int(np.argmax(counts[1:]) + 1)
iso = np.pad(iso, 2)
head_verts_mm, head_faces, _, _ = measure.marching_cubes(iso.astype(np.float32), level=0.5)
head_model = index_to_model((head_verts_mm - 2) / zooms)  # mm on the iso grid -> voxel index
head_mesh = trimesh.Trimesh(vertices=head_model, faces=head_faces, process=True)
if head_mesh.volume < 0:
    head_mesh.invert()
trimesh.smoothing.filter_taubin(head_mesh, lamb=0.5, nu=-0.53, iterations=10)
head_center = head_mesh.vertices.mean(axis=0)
head_mesh.vertices = head_mesh.vertices - head_center
head_mesh.visual.material = trimesh.visual.material.PBRMaterial(
    # alphaMode is required: without it a glTF material is OPAQUE and the alpha in
    # baseColorFactor is ignored, so the head would hide the tumor completely.
    baseColorFactor=[242, 232, 214, 128], alphaMode="BLEND",
    metallicFactor=0.0, roughnessFactor=0.4
)

# the same smoothed tumor geometry, placed at its true position in the head frame
tumor_in_head = mesh.copy()
tumor_in_head.vertices = tumor_in_head.vertices + (tumor_mean - head_center)

# --- the shown MRI slice as a textured plane through the head at its true height ---
ni, nj = data.shape[0], data.shape[1]
corners_idx = np.array([[-0.5, -0.5, k], [ni - 0.5, -0.5, k], [ni - 0.5, nj - 0.5, k], [-0.5, nj - 0.5, k]])
quad_verts = index_to_model(corners_idx) - head_center
quad_uv = np.array([[0, 1], [1, 1], [1, 0], [0, 0]], dtype=float)  # v origin bottom-left; row 0 (anterior) -> v = 1
slice_gray = window(data_disp[:, :, k])
keep = ndimage.binary_closing(slice_gray > 12, iterations=2)
labels_keep, n_keep = ndimage.label(keep)
if n_keep:
    counts = np.bincount(labels_keep.ravel())
    keep = labels_keep == int(np.argmax(counts[1:]) + 1)
keep = ndimage.binary_erosion(ndimage.binary_fill_holes(keep), iterations=4)  # sit just inside the shell
alpha = (ndimage.gaussian_filter(keep.astype(float), 1.0) * 255).clip(0, 255).astype(np.uint8)
rgb = np.repeat(slice_gray[..., None], 3, axis=2).copy()
grown = ndimage.maximum_filter(rgb, size=(5, 5, 1))
fringe = alpha < 200
rgb[fringe] = grown[fringe]  # no black fringe at the alpha-mask edge
slice_tex = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
quad = trimesh.Trimesh(vertices=quad_verts, faces=[[0, 1, 2], [0, 2, 3]], process=False)
quad.visual = trimesh.visual.TextureVisuals(
    uv=quad_uv,
    material=trimesh.visual.material.PBRMaterial(
        baseColorTexture=slice_tex, baseColorFactor=[255, 255, 255, 255],
        alphaMode="MASK", doubleSided=True
    ),
)

combined = trimesh.Scene({"brain": head_mesh, "tumor": tumor_in_head, "slice": quad})
combined.export(ASSETS / "brain_tumor.glb")
# Post-process the shipped app/assets/brain_tumor.glb with prep/optimize_scene.mjs
# (@gltf-transform 4.5 + meshoptimizer): weld, simplify the head mesh ONLY to 25 %,
# quantize positions (KHR_mesh_quantization, decoded natively by <model-viewer>,
# no runtime decoder, still fully offline), and mark the slice material unlit.
# The tumor keeps its exact triangle count. Result: ~8 MB -> ~1.4 MB.

# --- laterality cross-check: tumor centroid RAS-x vs brain-centroid RAS-x ---
cen_ras = (img.affine @ np.append(ndimage.center_of_mass(mask), 1))[:3]
brain_cen_ras = (img.affine @ np.append(ndimage.center_of_mass(brain), 1))[:3]
side = "venstre" if cen_ras[0] < brain_cen_ras[0] else "høyre"

# --- report (clinically supplied text; the app substitutes {volume}) ---
# "{volume}" stands for display + non-breaking space + unit, so the number and its
# unit can never be split across a line break or drift apart from the measurement.
# "R:" is the radiology shorthand for the conclusion heading, chosen by the author
# in commit f92402c ("content: abbreviate radiology conclusion heading").
report_paras = [
    "MR caput",
    "Kontrastladende tumor i cerebellopontine vinkel med utbredelse mot indre øregang, "
    "forenlig med vestibularisschwannom. Lett lokal påvirkning av omkringliggende strukturer.",
    "KI-generert tumorvolum: {volume}.",
    "R:",
    "Funn forenlig med vestibularisschwannom. Tumorvolum {volume}, beregnet ved "
    "KI-basert 3D-segmentering.",
]

case = {
    "caseId": "vs_gk_1",
    "caseTitle": "MR-snitt av hjernen",
    "assets": {
        "slice": "assets/slice.png",
        "overlay": "assets/overlay.png",
        "mesh": "assets/tumor.glb",
        "brainTumor": "assets/brain_tumor.glb",
    },
    "stack": {
        "sliceUrl": "assets/slices/slice_%03d.png",
        "overlayUrl": "assets/slices/overlay_%03d.png",
        "count": n_slices,
        "best": k,
        "overlayRange": [overlay_idx[0], overlay_idx[-1]],
    },
    "volume": {"exactMl": round(vol_ml, 3), "display": vol_display, "unit": "cm\u00b3"},
    "slice": {"index": k, "plane": "axial"},
    "report": {
        "title": "KI-generert rapportutkast.",
        "textNob": report_paras,
    },
}
(APP / "case.json").write_text(json.dumps(case, ensure_ascii=False, indent=2), encoding="utf-8")

verify = {
    "shape": list(img.shape),
    "zooms_mm": zooms.round(4).tolist(),
    "orientation": "".join(nib.aff2axcodes(img.affine)),
    "display_orientation": "radiological axial (swapaxes 0/1: rows->P, cols->L)",
    "intensity_window": [round(float(win_lo), 3), round(float(win_hi), 3)],
    "affine_equal": True,
    "mask_labels": labels.tolist(),
    "mask_slice_k": sorted(int(i) for i in np.where(mask.any(axis=(0, 1)))[0]),
    "shown_slice_k": k,
    "stack_count": n_slices,
    "voxel_count": voxel_count,
    "voxel_volume_mm3": round(voxvol_mm3, 6),
    "volume_ml": round(vol_ml, 4),
    "marching_cubes_raw_volume_ml": round(raw_vol_ml, 4),
    "marching_cubes_smoothed_volume_ml": round(smooth_vol_ml, 4),
    "tumor_centroid_RAS_mm": cen_ras.round(2).tolist(),
    "brain_centroid_RAS_mm": brain_cen_ras.round(2).tolist(),
    "laterality": side,
}
(ROOT / "prep" / "verify.json").write_text(json.dumps(verify, ensure_ascii=False, indent=2))
print(json.dumps(verify, ensure_ascii=False, indent=2))

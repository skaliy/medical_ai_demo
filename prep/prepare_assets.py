"""Build everything the demo ships from one T1 MRI scan and its tumour mask.

Writes the slice stack and overlays (app/assets/slices/), the tumour-only and
head-with-tumour models (app/assets/tumor.glb, app/assets/brain_tumor.glb),
app/case.json and prep/verify.json. See prep/README.md.
"""
import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from skimage import measure

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
VERIFY_JSON = ROOT / "prep" / "verify.json"
DEFAULT_IMAGE = ROOT / "vs_gk_1_t1_refT1.nii.gz"
DEFAULT_MASK = ROOT / "vs_gk_1_seg_refT1.nii.gz"

CASE_ID = "vs_gk_1"
# Asset paths relative to app/, exactly as written to case.json.
WITH_HEAD_GLB = "assets/brain_tumor.glb"
TUMOR_ONLY_GLB = "assets/tumor.glb"
SLICE_URL = "assets/slices/slice_%03d.png"
OVERLAY_URL = "assets/slices/overlay_%03d.png"

WINDOW_PERCENTILES = (0.5, 99.5)
OVERLAY_RGB = (255, 45, 149)  # magenta
OVERLAY_FILL_ALPHA = 70
TUMOR_RGBA = [224, 82, 150, 255]
HEAD_RGBA = [242, 232, 214, 128]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--image", type=Path, default=DEFAULT_IMAGE,
                        help=f"T1 MRI as NIfTI (default: {DEFAULT_IMAGE.name} in the repository root)")
    parser.add_argument("--mask", type=Path, default=DEFAULT_MASK,
                        help=f"tumour mask as NIfTI, labels 0/1, on the same grid as --image "
                             f"(default: {DEFAULT_MASK.name} in the repository root)")
    return parser.parse_args()


def load_scan(image_path, mask_path):
    """Load image and mask, and check they share one LPS voxel grid."""
    img = nib.load(image_path)
    msk_img = nib.load(mask_path)
    assert img.shape == msk_img.shape, "image and mask shapes differ"
    assert np.allclose(img.affine, msk_img.affine, atol=1e-6), "image and mask affines differ"
    labels = np.unique(np.asanyarray(msk_img.dataobj))
    assert set(labels.tolist()) <= {0, 1}, f"unexpected mask labels: {labels}"
    # to_display() and index_to_model() assume this orientation.
    axcodes = nib.aff2axcodes(img.affine)
    assert axcodes == ("L", "P", "S"), f"expected LPS orientation, got {''.join(axcodes)}"
    data = img.get_fdata(dtype=np.float32)
    mask = np.asanyarray(msk_img.dataobj) > 0
    return img, data, mask, labels


def to_display(vol):
    """Native LPS array -> radiological axial display orientation.

    Native LPS: axis0 -> Left, axis1 -> Posterior. As a plain array image that
    puts the patient's right on top and the eyes (anterior) to the LEFT.
    Swapping axes 0/1 makes rows increase toward P (top = anterior, eyes up)
    and columns increase toward L (viewer left = patient right): the way a
    radiologist reads axial slices. Mesh building keeps the native array.
    """
    return np.swapaxes(vol, 0, 1)


def intensity_window(data):
    """One window over the whole volume, so the stack does not flicker while scrolling."""
    sub = data[::2, ::2, ::2]
    win_lo, win_hi = np.percentile(sub, WINDOW_PERCENTILES)
    return win_lo, win_hi


def window(sl, win):
    win_lo, win_hi = win
    g = np.clip((sl - win_lo) / (win_hi - win_lo), 0, 1)
    return (g * 255).astype(np.uint8)


def overlay_rgba(m2):
    """Translucent fill plus an opaque one-pixel outline of a 2D mask."""
    filled = ndimage.binary_fill_holes(m2)
    rgba = np.zeros((*m2.shape, 4), dtype=np.uint8)
    rgba[..., :3] = OVERLAY_RGB
    rgba[..., 3] = (filled * OVERLAY_FILL_ALPHA).astype(np.uint8)
    boundary = m2 & ~ndimage.binary_erosion(m2)
    rgba[boundary, 3] = 255
    return rgba


def largest_component(binary):
    labels, n = ndimage.label(binary)
    if not n:
        return binary
    counts = np.bincount(labels.ravel())
    return labels == int(np.argmax(counts[1:]) + 1)


def write_slice_stack(data_disp, mask_disp, win):
    """Write every axial slice, plus an overlay on each slice the mask touches.

    Returns the slice count and the indices that got an overlay.
    """
    n_slices = data_disp.shape[2]
    overlay_idx = [kk for kk in range(n_slices) if mask_disp[:, :, kk].any()]
    for kk in range(n_slices):
        Image.fromarray(window(data_disp[:, :, kk], win)).save(APP / (SLICE_URL % kk))
        if kk in overlay_idx:
            Image.fromarray(overlay_rgba(mask_disp[:, :, kk])).save(APP / (OVERLAY_URL % kk))
    print(f"wrote {n_slices} slices, overlays on {overlay_idx[0]}-{overlay_idx[-1]}")
    return n_slices, overlay_idx


# Model frame: x = -RAS x (viewer left = patient right, radiological), y = RAS z
# (up), z = RAS y (anterior toward the camera). Every mesh in the scene is placed
# in this ONE frame and then translated by the same head centre, so the tumor
# sits at its true position inside the head. Centring each mesh on its own
# centroid instead would draw the tumor in the middle of the head.
def index_to_model(affine, idx):
    hom = np.column_stack([idx, np.ones(len(idx))])
    ras = (affine @ hom.T).T[:, :3]
    return np.column_stack([-ras[:, 0], ras[:, 2], ras[:, 1]])


def build_tumor_mesh(mask, affine):
    """Marching cubes on the exact mask, no decimation: the mesh carries the measurement.

    Returns the smoothed mesh centred on its own mean (the tumor-only view), that
    mean in the model frame, and the mesh volume in mL before and after smoothing.
    """
    verts, faces, _, _ = measure.marching_cubes(mask.astype(np.float32), level=0.5)
    tumor_model = index_to_model(affine, verts)
    tumor_mean = tumor_model.mean(axis=0)
    mesh = trimesh.Trimesh(vertices=tumor_model - tumor_mean, faces=faces, process=True)
    if mesh.volume < 0:
        mesh.invert()  # ensure outward-facing winding for GLB rendering
    raw_vol_ml = abs(mesh.volume) / 1000.0
    trimesh.smoothing.filter_taubin(mesh, iterations=8)
    smooth_vol_ml = abs(mesh.volume) / 1000.0
    mesh.visual.material = trimesh.visual.material.PBRMaterial(
        baseColorFactor=TUMOR_RGBA, main_color=TUMOR_RGBA
    )
    return mesh, tumor_mean, raw_vol_ml, smooth_vol_ml


def head_mask(data):
    """Voxel mask of the head. Display context only; the tumor stays the measured mask."""
    head = data > 0.15 * np.percentile(data[data > 0], 98)
    head = ndimage.binary_fill_holes(head)
    head = ndimage.binary_closing(head, iterations=2)
    return largest_component(head)


def build_head_mesh(head, zooms, affine):
    """A clean, translucent outer shell of the head, centred on its own mean.

    Returns the mesh and the centre that was subtracted (model frame).
    """
    # Resample to a 1 mm grid, fill and close so sinuses and ear canals do not leave
    # noisy interior surfaces inside the translucent shell, keep the largest blob.
    iso = ndimage.zoom(head.astype(np.uint8), zooms, order=0).astype(bool)
    iso = ndimage.binary_fill_holes(iso)
    ball = ndimage.iterate_structure(ndimage.generate_binary_structure(3, 1), 3)
    iso = ndimage.binary_closing(iso, structure=ball)
    iso = ndimage.binary_fill_holes(iso)
    iso = largest_component(iso)
    iso = np.pad(iso, 2)
    verts_mm, faces, _, _ = measure.marching_cubes(iso.astype(np.float32), level=0.5)
    model = index_to_model(affine, (verts_mm - 2) / zooms)  # mm on the iso grid -> voxel index
    mesh = trimesh.Trimesh(vertices=model, faces=faces, process=True)
    if mesh.volume < 0:
        mesh.invert()
    trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=10)
    center = mesh.vertices.mean(axis=0)
    mesh.vertices = mesh.vertices - center
    mesh.visual.material = trimesh.visual.material.PBRMaterial(
        # alphaMode is required: without it a glTF material is OPAQUE and the alpha in
        # baseColorFactor is ignored, so the head would hide the tumor completely.
        baseColorFactor=HEAD_RGBA, alphaMode="BLEND",
        metallicFactor=0.0, roughnessFactor=0.4
    )
    return mesh, center


def build_slice_plane(slice_gray, shape, k, affine, head_center):
    """The shown MRI slice as a textured plane through the head at its true height."""
    ni, nj = shape[0], shape[1]
    corners_idx = np.array([[-0.5, -0.5, k], [ni - 0.5, -0.5, k], [ni - 0.5, nj - 0.5, k], [-0.5, nj - 0.5, k]])
    quad_verts = index_to_model(affine, corners_idx) - head_center
    quad_uv = np.array([[0, 1], [1, 1], [1, 0], [0, 0]], dtype=float)  # v origin bottom-left; row 0 (anterior) -> v = 1
    keep = ndimage.binary_closing(slice_gray > 12, iterations=2)
    keep = largest_component(keep)
    keep = ndimage.binary_erosion(ndimage.binary_fill_holes(keep), iterations=4)  # sit just inside the shell
    alpha = (ndimage.gaussian_filter(keep.astype(float), 1.0) * 255).clip(0, 255).astype(np.uint8)
    rgb = np.repeat(slice_gray[..., None], 3, axis=2).copy()
    grown = ndimage.maximum_filter(rgb, size=(5, 5, 1))
    fringe = alpha < 200
    rgb[fringe] = grown[fringe]  # no black fringe at the alpha-mask edge
    texture = Image.fromarray(np.dstack([rgb, alpha]))
    quad = trimesh.Trimesh(vertices=quad_verts, faces=[[0, 1, 2], [0, 2, 3]], process=False)
    quad.visual = trimesh.visual.TextureVisuals(
        uv=quad_uv,
        material=trimesh.visual.material.PBRMaterial(
            baseColorTexture=texture, baseColorFactor=[255, 255, 255, 255],
            alphaMode="MASK", doubleSided=True
        ),
    )
    return quad


def ras_centroid(affine, binary):
    return (affine @ np.append(ndimage.center_of_mass(binary), 1))[:3]


def main():
    args = parse_args()
    img, data, mask, labels = load_scan(args.image, args.mask)
    zooms = np.array(img.header.get_zooms()[:3], dtype=float)
    voxvol_mm3 = float(np.prod(zooms))
    data_disp = to_display(data)
    mask_disp = to_display(mask)

    # Shown slice: the largest axial cross-section (axis 2 = S, unaffected by the swap).
    area = mask.sum(axis=(0, 1))
    k = int(np.argmax(area))
    print(f"chosen axial slice k={k}, area={int(area[k])} px")

    # Volume from the full 3D mask: voxel count x voxel volume.
    voxel_count = int(mask.sum())
    vol_ml = voxel_count * voxvol_mm3 / 1000.0
    # One rounding for the whole demo: case.json is the single source of the number
    # every screen shows, so the dialog and the report can never disagree.
    vol_display = f"{vol_ml:.2f}".replace(".", ",")

    win = intensity_window(data)
    (APP / SLICE_URL).parent.mkdir(parents=True, exist_ok=True)
    n_slices, overlay_idx = write_slice_stack(data_disp, mask_disp, win)

    tumor, tumor_mean, raw_vol_ml, smooth_vol_ml = build_tumor_mesh(mask, img.affine)
    tumor.export(APP / TUMOR_ONLY_GLB)

    head = head_mask(data)
    head_mesh, head_center = build_head_mesh(head, zooms, img.affine)
    # The same smoothed tumor geometry, placed at its true position in the head frame.
    # copy() drops the material, which optimize_scene.mjs needs, so set it again.
    tumor_in_head = tumor.copy()
    tumor_in_head.vertices = tumor_in_head.vertices + (tumor_mean - head_center)
    tumor_in_head.visual.material = tumor.visual.material
    plane = build_slice_plane(window(data_disp[:, :, k], win), data.shape, k, img.affine, head_center)
    scene = trimesh.Scene({"brain": head_mesh, "tumor": tumor_in_head, "slice": plane})
    scene.export(APP / WITH_HEAD_GLB)
    # Then post-process brain_tumor.glb with prep/optimize_scene.mjs: it simplifies
    # the head only, quantizes positions and marks the slice material unlit, which
    # trimesh cannot express. The tumor keeps its exact triangle count.

    # Laterality cross-check: tumor centroid vs head centroid along RAS x (+x = right).
    cen_ras = ras_centroid(img.affine, mask)
    head_cen_ras = ras_centroid(img.affine, head)
    side = "venstre" if cen_ras[0] < head_cen_ras[0] else "høyre"

    case = {
        "caseId": CASE_ID,
        "models": {"withHead": WITH_HEAD_GLB, "tumorOnly": TUMOR_ONLY_GLB},
        "stack": {
            "sliceUrl": SLICE_URL,
            "overlayUrl": OVERLAY_URL,
            "count": n_slices,
            "best": k,
            "overlayRange": [overlay_idx[0], overlay_idx[-1]],
        },
        "volume": {"exactMl": round(vol_ml, 3), "display": vol_display, "unit": "cm³"},
    }
    (APP / "case.json").write_text(json.dumps(case, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    win_lo, win_hi = win
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
        "brain_centroid_RAS_mm": head_cen_ras.round(2).tolist(),
        "laterality": side,
    }
    VERIFY_JSON.write_text(json.dumps(verify, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(verify, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

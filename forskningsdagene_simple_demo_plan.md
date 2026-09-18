# Forskningsdagene: simple medical AI demo

## Scope

Build one small web app with one curated vestibular schwannoma case and four steps:

**Inspect a 2D MRI slice → reveal the saved tumor segmentation → explore the tumor in 3D → show a prepared AI report.**

All segmentation, measurement, mesh preparation, and multimodal report generation happen before the event. The event app displays saved assets. No live inference, chatbot, database, model API, or application backend is required.

This plan replaces the broader kiosk concept. Do not add expert-comparison exercises, failure cases, scoring, five-model comparisons, voice interaction, or additional cases to the initial implementation.

## 1. Visitor journey

### Step 1: Inspect

Show one large, preselected MRI slice containing the target, with no overlay and no report. Use the prompt **“Ser du noe som skiller seg ut?”**

Students can point and discuss; no digital answer or scoring is required. Keep the view uncluttered and use a single primary button: **“Vis KI-funnet.”**

### Step 2: Reveal

Display the saved segmentation as a colored outline and/or translucent overlay on exactly the same slice, without changing its crop, orientation, or scale. Include a simple show/hide toggle.

Brief caption: **“Dette er området KI-modellen har markert som svulst.”**

Next button: **“Se i 3D.”**

### Step 3: Explore in 3D

Show a rotatable, zoomable surface generated from the complete 3D prediction. Keep the original slice with its overlay visible beside it so visitors can connect the two views.

Display the checked volume as **“Volum beregnet fra KI-markeringen: [value] mL.”** Add **“3D-formen er laget fra hele bildeserien, ikke bare dette ene snittet.”**

The initial version does not need full brain reconstruction, volume rendering, or a slice-navigation interface. A tumor mesh and the matching 2D image are enough.

Next button: **“Generer KI-rapport.”** Put the visible note **“Viser et eksempel generert på forhånd”** beside the button. Do not simulate a live model call or invent a progress display.

### Step 4: Show the report

Open a report panel beside the image/3D view. Use the title **“KI-generert rapportutkast.”** Display a short, reviewed, Norwegian Bokmål explanation of the highlighted finding and supplied volume.

Show the input provenance directly under the report: **“Grunnlag: dette MR-snittet, KI-markeringen og volum beregnet fra hele 3D-segmenteringen.”**

Also label it **“Generert på forhånd og faglig gjennomgått”** only after that review has actually happened. If text has been materially edited, identify it as an AI draft edited for the demonstration.

Provide **“Start på nytt”**, which clears the overlay, report, and camera state and returns to the initial slice.

Keep **“Forskningsdemo – ikke for diagnostikk”** visible throughout.

## 2. Assets to prepare

Select one case approved for public display and use the existing inference pipeline. Keep its prediction provenance accurate; do not present a training-case output as performance on an unseen case.

Export the following:

| Asset | Purpose |
|---|---|
| `slice.png` | The exact unannotated slice shown first and supplied to the multimodal model. |
| `overlay.png` | Transparent segmentation overlay with identical dimensions and alignment. |
| `tumor.glb` | Interactive 3D surface derived from the complete saved prediction. |
| `case.json` | Asset paths, checked volume and unit, approved case facts, and saved report. |

An annotated copy of the same slice can also be prepared for the multimodal model. Retain the source scan, mask, measurement record, generation inputs, and original model output in the preparation workspace; the app does not need to distribute all of them.

Calculate volume from the complete 3D mask using its physical voxel geometry, not from the screenshot or a smoothed display mesh. Slicer documents labelmap volume as voxel count multiplied by voxel volume. [1]

Confirm that the slice, overlay, and mesh come from the same prediction and align correctly. Preserve orientation and check left/right labels. The volume shown in the interface and report must agree, including units and rounding.

## 3. Generate the report before the event

Send the multimodal model:

- The exact MRI slice shown to students, optionally accompanied by an annotated copy of the same slice.
- The checked tumor volume from the full 3D segmentation, with its unit and measurement provenance.
- Any verified case facts needed for the explanation, such as the known diagnosis or side. Do not ask the model to guess missing facts.

Suggested prompt:

> Write a short educational report in Norwegian Bokmål for students without medical training. You receive one MRI slice, an annotated copy of that same slice, and a tumor-volume measurement computed from the full 3D segmentation. Describe the highlighted finding and include the supplied volume and units exactly, identifying the measurement as derived from the segmentation. Use diagnosis and laterality only when supplied as verified case information. Do not add unsupported findings, claims that other anatomy is normal, symptoms, treatment advice, or prognosis. Do not imply that you reviewed the full MRI examination or measured the volume from this single slice. Use three to five clear sentences.

Check the generated draft against the supplied image and facts with an appropriate clinical reviewer. Save the reviewed text in `case.json`. Record whether it was edited. The report button simply reveals this saved result.

Distinguish a genuine model-generated draft from a manually written mockup. Do not label a hand-authored placeholder as an actual model output.

## 4. Minimal implementation

Use a small React/TypeScript application, or an equally simple static frontend. Render the 2D image and overlay as aligned image layers. Use a lightweight 3D mesh viewer such as `<model-viewer>` for the rotatable model; its official documentation describes built-in camera controls. [2]

Represent the journey with four UI states: `inspect`, `reveal`, `explore`, and `report`. Load all assets locally and serve the built app using a local static server at the event. Bundle the viewer library rather than depending on a CDN. Preload the model and report, but do not expose the answer before the reveal step.

No model credentials, inference service, DGX connection, database, or visitor uploads belong in this version.

## 5. Build order and completion check

First prepare one verified case and its report. Then implement the image/overlay reveal, add the 3D mesh and volume card, and finally add the report panel and reset control.

Use large controls and test on the actual display with mouse or touch. Keep the overall visual emphasis on the image and 3D shape rather than text.

The demo is complete when the four-step route works with external networking disconnected, the overlay is aligned, the 3D view rotates smoothly, every displayed volume matches the saved measurement, and reset returns to an unannotated slice. Review the final display assets for identifying information and public-display permission before the event.

**Final scope: one case, one slice, one reveal, one rotatable 3D tumor, one prepared report.**

## Technical references

[1] 3D Slicer, Segment statistics: https://slicer.readthedocs.io/en/latest/user_guide/modules/segmentstatistics.html

[2] `<model-viewer>`, Staging & Camera Control: https://modelviewer.dev/examples/stagingandcameras/

These references support the measurement and viewer capabilities. The workflow and interface are proposed design choices, not a clinically validated system.

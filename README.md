# Vestibular schwannoma demo

An interactive demo built for Forskningsdagene to show visitors how AI can support
the reading of medical images.

Live: <https://medical-ai-demo.pages.dev/>

It walks through one real MRI case in four steps:

1. Look at an MRI slice and see if anything stands out.
2. Reveal the tumour area the AI model has marked.
3. Explore the tumour as a rotatable 3D shape, with its calculated volume.
4. Read an AI-generated draft report describing the finding.

The text is in Norwegian, and everything shown is prepared in advance.

Imaging data comes from The Cancer Imaging Archive's
[Vestibular Schwannoma Segmentation](https://www.cancerimagingarchive.net/collection/vestibular-schwannoma-seg/)
collection. See [prep/README.md](prep/README.md) for how the assets are derived.

## Data licence

The MRI data and tumour segmentation come from the Vestibular-Schwannoma-SEG
collection, which is published under the
[Creative Commons Attribution 4.0 International licence (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
Use of the data is also subject to the
[TCIA Data Usage Policy](https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/).

This repository does not ship the original data. The slice images, overlays and
3D meshes in `app/assets/` and the tumour volume in `app/case.json` are derived
from one case of the collection, as described in [prep/README.md](prep/README.md).

Data citation:

> Shapey, J., Kujawa, A., Dorent, R., Wang, G., Bisdas, S., Dimitriadis, A.,
> Grishchuck, D., Paddick, I., Kitchen, N., Bradford, R., Saeed, S., Ourselin, S.,
> & Vercauteren, T. (2021). *Segmentation of Vestibular Schwannoma from Magnetic
> Resonance Imaging: An Open Annotated Dataset and Baseline Algorithm* (version 2)
> [Data set]. The Cancer Imaging Archive.
> <https://doi.org/10.7937/TCIA.9YTJ-5Q73>

Publication citation:

> Shapey, J., Kujawa, A., Dorent, R., Wang, G., Dimitriadis, A., Grishchuk, D.,
> Paddick, I., Kitchen, N., Bradford, R., Saeed, S. R., Bisdas, S., Ourselin, S.,
> & Vercauteren, T. (2021). Segmentation of vestibular schwannoma from MRI, an open
> annotated dataset and baseline algorithm. *Scientific Data*, 8(1).
> <https://doi.org/10.1038/s41597-021-01064-w>

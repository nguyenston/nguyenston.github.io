# Hello, I’m Nguyen Phuc Nguyen

I am a Ph.D. candidate in Systems Engineering at Boston University with a background in Computer Science and Physics. I work on problems that sit at the intersection of **software systems, optimization, and applied machine learning**, where careful reasoning about state, scalability, and failure modes matters as much as raw performance.

Alongside my academic research, I build independent software projects to explore system design, tooling, and end-to-end implementation in realistic settings.

## Education

* **Ph.D. in Systems Engineering** | Boston University (Expected 2026)
* **B.S. in Computer Science** & **B.A. in Physics** | Syracuse University (2021)

## Research & Professional Experience

I am currently a Graduate Research Assistant at the **Paschalidis NOC Lab**, where I apply machine learning and systems methods to clinical and theoretical problems.

* **Production ML Pipelines**  
  Designed, built, and deployed an end-to-end ML pipeline trained on a 100,000-patient dataset, now running weekly inference in support of a clinical trial on hypertension prescription at Boston Medical Center.  
  I also engineered a data pipeline processing a 10-year dataset (30,000 appointments across 6,000 patients) to predict missed CT screenings and enable targeted patient support.

* **Algorithm Design**  
  Developed a spectral algorithm for discovering latent policies from demonstrations, guaranteeing global convergence in a single data pass and avoiding common failure modes of Expectation–Maximization methods.

* **Latent Process Modeling**  
  Contributed to the design and implementation of a flexible framework for discovering latent processes, with applications in bioinformatics (mutation analysis) and remote sensing (hyperspectral unmixing).

## Selected Projects

### [Mokuro Library](https://github.com/nguyenston/mokuro-library)

A self-hosted, multi-user library for reading and editing OCR-backed comics and documents, designed to run on home servers or NAS environments.

This project grew out of a desire to have a reader that treats OCR data as *first-class, editable content* rather than a static artifact, while remaining practical to self-host and maintain.

**Highlights:**

- **Server-backed library and storage**  
  All content and metadata live on the server filesystem, avoiding browser storage limits and enabling access across devices and users.

- **Multi-user design with private state**  
  Users share a common library while maintaining independent reading progress, bookmarks, and OCR edits.

- **Interactive OCR reader and editor**  
  Documents are displayed with selectable OCR text overlays, and OCR output can be corrected directly in the browser by editing text and adjusting bounding boxes in place.

- **Non-destructive OCR editing**  
  OCR changes are tracked as structured edits rather than overwriting files, enabling undo/redo, reset to the original version, and reconciliation with upstream updates.

- **Performance-aware document viewing**  
  Long documents are rendered using virtualized scrolling to avoid performance and memory issues when viewing hundreds of pages.

- **Reliable export for large archives**  
  Volumes and collections can be exported as ZIP or PDF files using streaming downloads, avoiding large in-memory buffers and supporting stable downloads for large libraries.

- **Designed for self-hosting**  
  Runs locally via Docker Compose with minimal configuration, making it suitable for trusted LAN or VPN setups.

### [Matter Phase Simulation](https://github.com/nguyenston/Van_Der_Waals_Interactions)

A systems-oriented simulation project exploring emergent physical phenomena using Rust.

This project implements a particle simulation with an efficient grid-based method to visualize non-ideal gas behavior, crystalline formation, and annealing processes, using the Bevy engine for visualization.

### [Quantum Virtual Machine (QVIM)](https://github.com/nguyenston/QViM)

An experimental project exploring language design and metaprogramming in Julia.

QVIM provides a domain-specific language for expressing quantum logic circuits with readable syntax, along with a simulator that optimizes gate operations via basis changes.

## Technical Skills

| Domain | Tools & Languages |
| :--- | :--- |
| **Languages** | Python, TypeScript, Julia, Rust, Bash, SQL, C++, C, Lua |
| **ML & Data** | PyTorch, scikit-learn, Hugging Face, pandas, Weights & Biases, cvxpy, Jupyter |
| **Systems & Dev** | Docker, Git, Linux/Unix, Nix, Cargo, Conda, LaTeX |
| **Core Competencies** | Data Structures, Algorithms, Probability, Statistics, Optimization, Linear Programming |

---

### Connect

* **GitHub**: https://github.com/nguyenston  
* **LinkedIn**: https://linkedin.com/in/nguyenston  
* **Resume**: [View PDF](/Nguyen_Nguyen_resume.pdf)

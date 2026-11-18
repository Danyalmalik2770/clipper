# Contributing to Clipper

Contributions are welcome!

1. Fork the repository and create a feature branch.
2. To add a new caption or layout preset, drop a JSON file in `/templates/captions/` or `/templates/layouts/` following the existing schema.
3. Run tests and build checks before opening a Pull Request:
```bash
npm test
npm run build:electron
npm run build:next
```

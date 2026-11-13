# WRF Zarr fixture

`generate.py` uses av-wrf's metadata and binary encoders, then checks every field
with zarr-python before writing the sampled values in `oracle.json`.

```sh
../av-wrf/.venv/bin/python scripts/fixtures/wrf-zarr/generate.py --producer ../av-wrf
```

Generated with av-wrf commit `55a53ce10b3d5c7cf76eb32325a72ea9ef855f2b`.
The 5×3 grid has three levels and two hours. Values vary by each axis;
64×64 inner chunks exercise NaN padding around the valid grid. The committed
files let TypeScript tests run without Python or a producer checkout.

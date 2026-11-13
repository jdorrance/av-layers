"""Generate the consumer fixture with av-wrf's independent Python encoders."""

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--producer", type=Path, required=True)
args = parser.parse_args()
sys.path.insert(0, str(args.producer.resolve() / "src"))

import numpy as np
import zarr

from av_wrf.codecs.zarr_shard import (
    encode_2d_shard_bytes, encode_3d_shard_bytes, encode_coord_chunks,
)
from av_wrf.codecs.zarr_v3 import build_zarr_v3_store_metadata, zarr_shard_relpath
from av_wrf.contracts import (
    DomainProfile, OutputProfile, PubMass2D, PubMass3D, ReadyReceipt,
    Slab2DF32, Slab3DF32, WRF_ZARR_V3_FIELDS,
)
from av_wrf.core import published_lambert_grid_metadata

root = Path(__file__).resolve().parent
store = root / "forecast.zarr"
domain = DomainProfile(
    profile_id="consumer-fixture", earth_radius_m=6370000,
    center_lat_deg=40.2, center_lon_deg=44.5,
    std_parallel_1_deg=38.5, std_parallel_2_deg=41.8, central_meridian_deg=44.5,
    dx_m=3000, dy_m=3000, e_we=8, e_sn=6, bdy_trim_cells=1,
    e_vert=4, exported_levels_k=3, p_top_pa=5000, auto_levels_opt=2,
    dzbot_m=50, dzstretch_s=1.1, dzstretch_u=1.06, max_dz_m=850,
    min_bl_levels_2km_agl=3, terrain_elevations_m=(100,),
    dem_source="fixture", landuse_source="fixture", geog_data_path="fixture",
)
output = OutputProfile("consumer-fixture", "wrf-zarr-v3", 2, 2, 1, 1, (64, 64), 3)
leads = (1, 2)
origin = datetime(2026, 11, 13, tzinfo=timezone.utc)
valid = tuple(origin + timedelta(hours=h) for h in leads)
starts = tuple(origin + timedelta(hours=h - 1) for h in leads)
stamp = lambda value: value.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")


def write_bytes(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


for key, metadata in build_zarr_v3_store_metadata(domain, output, leads).items():
    write_json(store / key, metadata)
for key, chunk in encode_coord_chunks(
    domain, leads, tuple(int(t.timestamp()) for t in valid),
    tuple(int(t.timestamp()) for t in starts), tuple(int(t.timestamp()) for t in valid),
).items():
    write_bytes(store / key, chunk)

# Distinct time, level, row and column values expose axis-order mistakes.
y, x = np.indices((3, 5))
cell = (5 * y + x).astype(np.float32)
surface = {
    "terrain_m": (100, 1, 0), "surface_pressure_pa": (100000, -2, 10),
    "temp_2m_k": (293, .125, 1), "spfh_2m_kgkg": (.008, .00001, .0001),
    "sensible_heat_flux_wm2": (250, 1, 10), "latent_heat_flux_wm2": (100, 2, 5),
    "precip_mm_hr": (0, .25, 1), "mslp_pa": (101200, 2, 10),
    "u_10m_earth_mps": (5, .25, 1), "v_10m_earth_mps": (-3, .125, -1),
    "gust_10m_mps": (8, .25, 1), "pbl_height_m": (1500, 1, 10),
    "cape_jkg": (150, 1, 10), "cloud_total_pct": (20, 1, 10),
    "cloud_low_pct": (5, .25, 2),
}
levels = {
    "pressure_pa": (95000, -2, 10, -5000),
    "height_msl_m": (200, 1, 2, 500),
    "temp_k": (289, .125, 1, -4),
    "spfh_kgkg": (.007, .00001, .0001, -.001),
    "u_earth_mps": (10, .25, 1, 2),
    "v_earth_mps": (-5, .125, -1, -2),
    "omega_pas": (-.5, .03125, .125, .25),
}
expected = {}
for field in WRF_ZARR_V3_FIELDS:
    frames = []
    for t in range(1 if field.name == "terrain_m" else len(leads)):
        if len(field.dims) == 4:
            base, spatial, temporal, vertical = levels[field.name]
            values = np.asarray([
                base + spatial * cell + temporal * t + vertical * k for k in range(3)
            ], dtype=np.float32)
            slab = PubMass3D(Slab3DF32.from_values(3, 3, 5, values.ravel()))
            encoded = encode_3d_shard_bytes(slab, output)
        else:
            base, spatial, temporal = surface[field.name]
            values = np.asarray(base + spatial * cell + temporal * t, dtype=np.float32)
            slab = PubMass2D(Slab2DF32.from_values(3, 5, values.ravel()))
            encoded = encode_2d_shard_bytes(slab, output)
        key = zarr_shard_relpath(field.name, output, time_index=t)
        write_bytes(store / key, encoded)
        frames.append(values)
    expected[field.name] = frames[0] if field.name == "terrain_m" else np.stack(frames)

hashes = tuple((p.relative_to(store).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest())
               for p in sorted(store.rglob("*")) if p.is_file())
receipt = ReadyReceipt(
    schema_id="wrf-zarr-v3", schema_version=1, model_id="wrf-fixture",
    cycle_partition="20261113/00", publish_origin_utc=stamp(origin),
    attempt_id="fixture", zarr_relpath="forecast.zarr",
    grid={**published_lambert_grid_metadata(domain),
          "demSource": "fixture", "landuseSource": "fixture"},
    exported_levels_k=3, lead_hours=leads,
    valid_times_utc=tuple(map(stamp, valid)), window_starts_utc=tuple(map(stamp, starts)),
    window_ends_utc=tuple(map(stamp, valid)),
    field_names=tuple(f.name for f in WRF_ZARR_V3_FIELDS), shard_sha256s=hashes,
    config_sha256="0" * 64, forcing_profile_id="fixture", oci_digest="sha256:" + "0" * 64,
)
write_json(root / "_ready.json", receipt.to_doc())

# A second, general-purpose Zarr reader verifies the producer output independently.
group = zarr.open_group(str(store), mode="r")
for name, values in expected.items():
    np.testing.assert_array_equal(group[name][:], values)
samples = []
for t, y, x in ((0, 0, 0), (0, 1, 2), (0, 2, 4), (1, 0, 0), (1, 2, 4)):
    fields = {}
    for name, values in expected.items():
        value = values[y, x] if name == "terrain_m" else (
            values[t, :, y, x] if values.ndim == 4 else values[t, y, x]
        )
        fields[name] = value.tolist()
    samples.append({"timeIndex": t, "y": y, "x": x, "fields": fields})
write_json(root / "oracle.json", {"samples": samples})
print(f"Verified {len(hashes)} objects and {len(expected)} fields with zarr-python")

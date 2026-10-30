#!/usr/bin/env python3
import concurrent.futures as futures
import datetime as dt
import hashlib
import json
import math
import re
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import eccodes as ec
import numpy as np

BASE = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/'
GRID_BASE = 'http://icon-downloads.mpimet.mpg.de/'
ALLOWED = {'opendata.dwd.de', 'icon-downloads.mpimet.mpg.de'}
LEVELS = list(range(45, 75))
HALF_LEVELS = list(range(45, 76))
SURFACE = ['T_2M', 'TD_2M', 'PS', 'MH']
STATS = ['ASHFL_S', 'ALHFL_S', 'TOT_PREC']
NATIVE = ['T', 'P']
SHORT_NAMES = {'T': 't', 'P': 'pres', 'HHL': 'HHL', 'T_2M': '2t', 'TD_2M': '2d', 'PS': 'sp',
               'MH': 'mld', 'ASHFL_S': 'avg_ishf', 'ALHFL_S': 'avg_slhtf', 'TOT_PREC': 'tp'}


def digest(body):
    return hashlib.sha256(body).hexdigest()


def write_json(path, obj):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(obj, allow_nan=False, separators=(',', ':')))
    tmp.replace(path)


class Fetcher:
    def __init__(self, root, budget):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.limit, self.bytes, self.reserved, self.retries = budget, 0, 0, 0
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.records = {}

    def get(self, url, byte_range=None, cap=8_000_000):
        if self.stopped.is_set():
            raise ValueError('ICON transfer stopped at its download budget')
        if urllib.parse.urlparse(url).hostname not in ALLOWED:
            raise ValueError('Unexpected ICON data host')
        key = url + (f'#{byte_range[0]}-{byte_range[1]}' if byte_range else '')
        headers = {'User-Agent': 'windy-av-icon-armenia/1'}
        if byte_range:
            headers['Range'] = f'bytes={byte_range[0]}-{byte_range[1]}'
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                    if urllib.parse.urlparse(response.url).hostname not in ALLOWED:
                        raise ValueError('Unexpected ICON data redirect')
                    if byte_range and (response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {byte_range[0]}-{byte_range[1]}/')):
                        raise ValueError('Grid server did not honor the requested byte range')
                    advertised = int(response.headers.get('Content-Length', '0'))
                    if advertised > cap:
                        raise ValueError(f'ICON object exceeds bounded transfer: {url}')
                    with self.lock:
                        reservation = advertised or cap
                        if self.bytes + self.reserved + reservation > self.limit:
                            self.stopped.set()
                            raise ValueError('ICON download budget exceeded')
                        self.reserved += reservation
                    try:
                        body = response.read(cap + 1)
                    finally:
                        with self.lock:
                            self.reserved -= reservation
                    if len(body) > cap or (advertised and len(body) != advertised):
                        raise ValueError('Oversized or incomplete ICON transfer')
                    with self.lock:
                        self.bytes += len(body)
                        if self.bytes > self.limit:
                            self.stopped.set()
                            raise ValueError('ICON download budget exceeded')
                        self.records[key] = {'url': url, 'range': byte_range, 'bytes': len(body), 'sha256': digest(body),
                                             'lastModified': response.headers.get('Last-Modified')}
                    return body
            except (OSError, TimeoutError) as error:
                if attempt == 2:
                    raise OSError(f'ICON transfer failed for {url}: {error}') from error
                with self.lock:
                    self.retries += 1
                time.sleep(1 + attempt)


def field_url(field, run, hour=0, level=None):
    path = field + ('/lvt1/150/lv1/' + str(level) if level is not None else '')
    return BASE + path + '/r/' + run[:16].replace(':', '%3A') + '/s/PT' + str(hour).zfill(3) + 'H00M.grib2'


def grib_decode(body):
    if len(body) < 20 or body[:4] != b'GRIB' or body[7] != 2 or int.from_bytes(body[8:16], 'big') != len(body) or body[-4:] != b'7777':
        raise ValueError('Expected exactly one complete GRIB2 field')
    g = ec.codes_new_from_message(body)
    try:
        keys = ['gridType', 'numberOfDataPoints', 'numberOfGridUsed', 'uuidOfHGrid', 'shortName', 'name', 'units',
                'stepType', 'dataDate', 'dataTime', 'validityDate', 'validityTime', 'typeOfFirstFixedSurface',
                'scaledValueOfFirstFixedSurface', 'scaleFactorOfFirstFixedSurface', 'packingType', 'packingError']
        meta = {k: ec.codes_get(g, k) for k in keys}
        ec.codes_set(g, 'stepUnits', 1)
        meta.update(startHour=float(ec.codes_get(g, 'startStep')), endHour=float(ec.codes_get(g, 'endStep')))
        values = ec.codes_get_values(g)
        missing = float(ec.codes_get(g, 'missingValue'))
        values[(values == missing) | ~np.isfinite(values)] = np.nan
        return meta, values
    finally:
        ec.codes_release(g)


class NetCDFHeader:
    def __init__(self, body):
        if body[:4] != b'CDF\x02':
            raise ValueError('Expected the official CDF-2 grid format')
        self.body, self.pos = body, 8
        self.dims = self.dimensions()
        self.attrs = self.attributes()
        self.variables = {}
        tag, count = self.uint(), self.uint()
        if tag != 11:
            raise ValueError('Grid variable list missing')
        for _ in range(count):
            name = self.string()
            dims = [self.uint() for _ in range(self.uint())]
            attrs = self.attributes()
            typ, size, offset = self.uint(), self.uint(), self.uint(8)
            self.variables[name] = {'type': typ, 'size': size, 'offset': offset,
                                    'shape': [self.dims[d][1] for d in dims], 'attributes': attrs}

    def uint(self, n=4):
        v = int.from_bytes(self.body[self.pos:self.pos+n], 'big')
        self.pos += n
        return v

    def string(self):
        n = self.uint()
        value = self.body[self.pos:self.pos+n].decode('utf-8')
        self.pos += (n + 3) // 4 * 4
        return value

    def dimensions(self):
        tag, count = self.uint(), self.uint()
        if tag != 10:
            raise ValueError('Grid dimensions missing')
        return [(self.string(), self.uint()) for _ in range(count)]

    def attributes(self):
        tag, count = self.uint(), self.uint()
        if tag not in (0, 12):
            raise ValueError('Invalid NetCDF attributes')
        result = {}
        formats = {1: ('b', 1), 2: ('c', 1), 3: ('h', 2), 4: ('i', 4), 5: ('f', 4), 6: ('d', 8)}
        for _ in range(count):
            name, typ, n = self.string(), self.uint(), self.uint()
            fmt, size = formats[typ]
            raw = self.body[self.pos:self.pos+n*size]
            self.pos += (n * size + 3) // 4 * 4
            values = raw.decode('utf-8') if typ == 2 else struct.unpack('>' + fmt * n, raw)
            result[name] = values if typ == 2 else values[0] if n == 1 else values
        return result


def range_groups(indices, gap=128):
    groups = []
    for value in sorted(set(int(i) for i in indices)):
        if groups and value - groups[-1][1] <= gap:
            groups[-1][1] = value
        else:
            groups.append([value, value])
    return groups


def grid_geometry(fetch, meta, indices, latitudes, longitudes, coordinate_tolerances):
    key = digest((meta['uuidOfHGrid'] + ',' + ','.join(map(str, indices))).encode())
    cache = fetch.root / ('geometry-' + key + '.json')
    if cache.exists():
        return json.loads(cache.read_text())
    registry = fetch.get(GRID_BASE + 'dwd_grids.xml')
    grids = ET.fromstring(registry)
    record = next((g for g in grids.iter('grid') if g.get('number_of_grid_used') == str(meta['numberOfGridUsed']) and g.get('centre') == '78'), None)
    if record is None:
        raise ValueError('Native ICON grid missing from the official grid registry')
    url = GRID_BASE + record.findtext('uri')
    header_bytes = fetch.get(url, (0, 65535), cap=65536)
    header = NetCDFHeader(header_bytes)
    uuid = header.attrs['uuidOfHGrid'].replace('-', '')
    if uuid != meta['uuidOfHGrid'] or dict(header.dims)['cell'] != meta['numberOfDataPoints']:
        raise ValueError('ICON grid UUID or dimensions disagree with the forecast GRIB')
    extracted = {}
    for name in ['clon', 'clat', 'clon_vertices', 'clat_vertices']:
        spec = header.variables[name]
        if spec['type'] != 6 or spec['shape'][0] != meta['numberOfDataPoints'] or spec['attributes'].get('units') not in ['radian', 'radians']:
            raise ValueError('Unexpected ICON grid coordinate encoding')
        expected_shape = [meta['numberOfDataPoints'], 3] if name.endswith('_vertices') else [meta['numberOfDataPoints']]
        if spec['shape'] != expected_shape:
            raise ValueError('Unexpected ICON triangular-grid dimensions')
        width = math.prod(spec['shape'][1:])
        out = {}
        for first, last in range_groups(indices):
            start = spec['offset'] + first * width * 8
            end = spec['offset'] + (last + 1) * width * 8 - 1
            raw = fetch.get(url, (start, end), cap=end-start+1)
            values = np.frombuffer(raw, dtype='>f8').reshape(-1, width) * 180 / math.pi
            for idx in indices:
                if first <= idx <= last:
                    out[int(idx)] = values[idx-first].tolist()
        extracted[name] = out
    cells = []
    for pos, idx in enumerate(indices):
        lon, lat = extracted['clon'][idx][0], extracted['clat'][idx][0]
        if abs(lon-longitudes[idx]) > coordinate_tolerances['CLON'] + 1e-9 or abs(lat-latitudes[idx]) > coordinate_tolerances['CLAT'] + 1e-9:
            raise ValueError(f'HTTP grid coordinates disagree with HTTPS forecast cell coordinates: {idx}: {(lat, lon)} vs {(latitudes[idx], longitudes[idx])}')
        corners = list(map(list, zip(extracted['clon_vertices'][idx], extracted['clat_vertices'][idx])))
        cells.append({'index': int(idx), 'id': f'icon-eu-{meta["numberOfGridUsed"]}-{idx}', 'latitude': lat, 'longitude': lon,
                      'corners': corners, 'cellIndex': pos})
    result = {'cells': cells, 'source': {'url': url, 'uuid': uuid, 'registrySha256': digest(registry),
                                       'headerSha256': digest(header_bytes), 'records': list(fetch.records.values())}}
    write_json(cache, result)
    return result


def verify_meta(meta, base, run, hour):
    expected = dt.datetime.fromisoformat(run.replace('Z', '+00:00'))
    valid = expected + dt.timedelta(hours=hour)
    if meta['gridType'] != 'unstructured_grid' or any(meta[k] != base[k] for k in ['uuidOfHGrid', 'numberOfDataPoints', 'numberOfGridUsed']):
        raise ValueError('ICON field grid mismatch')
    if str(meta['dataDate']) != expected.strftime('%Y%m%d') or meta['dataTime'] != expected.hour*100:
        raise ValueError('ICON field belongs to a different model run')
    if str(meta['validityDate']) != valid.strftime('%Y%m%d') or meta['validityTime'] != valid.hour*100 or meta['endHour'] != hour:
        raise ValueError('ICON field valid time mismatch')


def acquire(config):
    start = time.time()
    fetch = Fetcher(config['cacheDir'], config.get('maxDownloadBytes', 16_000_000_000))
    run, hours = config['referenceTime'], config['forecastHours']
    interval = config.get('intervalHours', 3)
    levels = config.get('levels', LEVELS)
    half_levels = config.get('halfLevels', HALF_LEVELS)
    bbox = config['bbox']
    coordinates = {}
    coordinate_tolerances = {}
    coordinate_sources = {}
    base_meta = None
    for field in ['CLAT', 'CLON', 'HSURF']:
        url = field_url(field, run)
        cache = fetch.root / (digest(url.encode()) + '.npz')
        if cache.exists():
            with np.load(cache) as saved:
                meta, values = json.loads(str(saved['metadata'])), saved['values']
                source = json.loads(str(saved['source'])) if 'source' in saved else None
            refresh = 'packingError' not in meta or source is None
        else:
            refresh = True
        if refresh:
            body = fetch.get(url)
            meta, values = grib_decode(body)
            source = fetch.records[url]
            temporary = cache.with_suffix('.tmp.npz')
            np.savez_compressed(temporary, metadata=json.dumps(meta), values=values, source=json.dumps(source))
            temporary.replace(cache)
        if source['url'] != url or not re.fullmatch('[a-f0-9]{64}', source['sha256']):
            raise ValueError('Cached ICON coordinate source mismatch')
        if not base_meta:
            base_meta = meta
        verify_meta(meta, base_meta, run, 0)
        if meta['stepType'] != 'instant' or meta['startHour'] != 0:
            raise ValueError(f'ICON {field} must be instantaneous at initialization')
        coordinates[field] = values
        coordinate_tolerances[field] = meta['packingError']
        coordinate_sources[field] = source
    lat, lon, terrain = [coordinates[k] for k in ['CLAT', 'CLON', 'HSURF']]
    selected = np.flatnonzero((lat >= bbox['south']) & (lat <= bbox['north']) & (lon >= bbox['west']) & (lon <= bbox['east']) & np.isfinite(terrain)).tolist()
    indices = sorted(int(i) for i in selected)
    maximum = int(config.get('maxCells', 12000))
    if not indices or len(indices) > maximum:
        raise ValueError(f'ICON extraction requires 1-{maximum} admitted native cells')
    geometry = grid_geometry(fetch, base_meta, indices, lat, lon, coordinate_tolerances)
    for cell in geometry['cells']:
        cell['terrainM'] = float(terrain[cell['index']])
    stat_hours = sorted(set(hours + [h-interval for h in hours if h-interval > 0]))
    specs = [(field, 0, level) for level in half_levels for field in ['HHL']]
    specs += [(field, hour, None) for hour in hours for field in SURFACE]
    specs += [(field, hour, None) for hour in stat_hours for field in STATS]
    specs += [(field, hour, level) for hour in hours for level in levels for field in NATIVE]
    records = {}
    done = 0

    def get_field(spec):
        field, hour, level = spec
        url = field_url(field, run, hour, level)
        cache = fetch.root / (digest((url + digest(','.join(map(str, indices)).encode())).encode()) + '.json')
        if cache.exists():
            record = json.loads(cache.read_text())
            if len(record['values']) != len(indices):
                raise ValueError('Cached ICON cell count mismatch')
        else:
            body = fetch.get(url)
            meta, values = grib_decode(body)
            record = {'field': field, 'hour': hour, 'level': level, 'metadata': meta,
                      'values': [float(v) if np.isfinite(v) else None for v in values[indices]],
                      'source': fetch.records[url]}
            write_json(cache, record)
        verify_meta(record['metadata'], base_meta, run, hour)
        m = record['metadata']
        source = record.get('source')
        if not source or source.get('url') != url or not re.fullmatch('[a-f0-9]{64}', source.get('sha256', '')) or not isinstance(source.get('bytes'), int) or source['bytes'] <= 0:
            raise ValueError('Cached ICON field source mismatch')
        if m['shortName'] != SHORT_NAMES[field]:
            raise ValueError(f'ICON field identity mismatch for {field}')
        if field not in STATS and (m['stepType'] != 'instant' or m['startHour'] != hour):
            raise ValueError(f'ICON {field} must be instantaneous at its endpoint')
        if level is not None and (str(m['typeOfFirstFixedSurface']) != '150' or m['scaleFactorOfFirstFixedSurface'] != 0 or m['scaledValueOfFirstFixedSurface'] != level):
            raise ValueError(f'ICON native level mismatch for {field} {level}')
        return spec, record

    with futures.ThreadPoolExecutor(max_workers=config.get('concurrency', 8)) as executor:
        for spec, record in executor.map(get_field, specs):
            records[':'.join(map(str, spec))] = record
            done += 1
            if done % 40 == 0 or done == len(specs):
                print(f'ICON: {done}/{len(specs)} fields, {fetch.bytes/1e6:.1f} MB downloaded', file=sys.stderr, flush=True)
    result = {'model': 'icon-eu', 'referenceTime': run, 'levels': levels, 'forecastHours': hours, 'intervalHours': interval,
              'bbox': bbox, 'grid': {'type': 'icon-native-triangular', 'uuid': base_meta['uuidOfHGrid'], 'number': base_meta['numberOfGridUsed'],
                       'pointCount': base_meta['numberOfDataPoints'], 'geometrySource': geometry['source'],
                       'coordinateSources': coordinate_sources},
              'cells': geometry['cells'], 'records': records,
              'provenance': {'provider': 'DWD', 'accessProduct': BASE, 'attribution': 'DWD, CC BY 4.0',
                             'downloadedBytes': fetch.bytes, 'downloads': len(fetch.records), 'retries': fetch.retries, 'elapsedSeconds': round(time.time()-start, 2),
                             'decoder': {'eccodes': ec.codes_get_api_version(), 'numpy': np.__version__},
                             'capturedAt': dt.datetime.now(dt.timezone.utc).isoformat()}}
    write_json(Path(config['output']), result)


if __name__ == '__main__':
    try:
        acquire(json.loads(Path(sys.argv[1]).read_text()))
    except Exception as error:
        print(f'ICON acquisition failed: {error}', file=sys.stderr)
        sys.exit(1)

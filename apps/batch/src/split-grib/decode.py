"""Decode one bounded ICON field at a time; stdin/stdout carry framed binary arrays."""

import bz2
import ctypes as ct
from datetime import datetime, timedelta, timezone
import json
from importlib.metadata import version
from pathlib import Path
import resource
import struct
import sys

import eccodes as ec
import eccodeslib
import numpy as np


class AecStream(ct.Structure):
    _fields_ = [("next_in", ct.c_void_p), ("avail_in", ct.c_size_t), ("total_in", ct.c_size_t),
                ("next_out", ct.c_void_p), ("avail_out", ct.c_size_t), ("total_out", ct.c_size_t),
                ("bits_per_sample", ct.c_uint), ("block_size", ct.c_uint), ("rsi", ct.c_uint),
                ("flags", ct.c_uint), ("state", ct.c_void_p)]


aec_directory, aec_name = ("lib", "libaec.dylib") if sys.platform == "darwin" else ("lib64", "libaec.so")
aec = ct.CDLL(str(Path(eccodeslib.__file__).parent / aec_directory / aec_name))
aec.aec_buffer_decode.argtypes = [ct.POINTER(AecStream)]
aec.aec_buffer_decode.restype = ct.c_int


def ccsds_values(payload, count, bits, flags, block_size, rsi):
    # ecCodes accepts short libaec output; check total_out to reject truncated fields.
    require(1 <= bits <= 32 and not flags & 1, "Unsupported CCSDS sample encoding")
    width = 1 if bits <= 8 else 2 if bits <= 16 else 4
    values = np.empty(count, dtype=f"u{width}")
    stream = AecStream(next_in=ct.cast(ct.c_char_p(payload), ct.c_void_p), avail_in=len(payload),
                       next_out=values.ctypes.data, avail_out=values.nbytes, bits_per_sample=bits,
                       block_size=block_size, rsi=rsi, flags=(flags & ~6) | (4 if sys.byteorder == "big" else 0))
    require(aec.aec_buffer_decode(ct.byref(stream)) == 0 and stream.total_out == values.nbytes,
            "Truncated or invalid CCSDS payload")
    return values


def verify_runtime():
    expected = json.loads((Path(__file__).resolve().parents[2] / "eccodes.json").read_text())
    actual = {"python": f"{sys.version_info.major}.{sys.version_info.minor}", "apiVersion": ec.codes_get_api_version(),
              "packages": {name: version(name) for name in expected["packages"]}}
    if actual != expected:
        raise RuntimeError(f"ecCodes runtime differs from eccodes.json: {actual}")
    return actual


def read_exact(count):
    data = sys.stdin.buffer.read(count)
    if len(data) != count:
        raise EOFError("Truncated decoder request")
    return data


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unpack_message(data, limit):
    if data[:3] == b"BZh":
        decoder = bz2.BZ2Decompressor()
        data = decoder.decompress(data, max_length=limit + 1)
        require(len(data) <= limit, "Split GRIB expanded object byte length out of bounds")
        require(decoder.eof and not decoder.unused_data, "Truncated or trailing bzip2 stream")
    require(20 <= len(data) <= limit, "Split GRIB expanded object byte length out of bounds")
    require(data[:4] == b"GRIB" and data[7] == 2 and data[-4:] == b"7777"
            and int.from_bytes(data[8:16], "big") == len(data), "Invalid GRIB2 message framing")
    sections = {}
    offset = 16
    while offset < len(data) - 4:
        length = int.from_bytes(data[offset:offset + 4], "big")
        require(length >= 5 and offset + length <= len(data) - 4, "Truncated GRIB2 section")
        number = data[offset + 4]
        require(number not in sections, "Expected exactly 1 GRIB2 field in Split GRIB object")
        sections[number] = length
        offset += length
    require(list(sections) in ([1, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]), "Invalid GRIB2 section order")
    return data, sections


HOURS = {0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600}


def decode(data, config, indices, target):
    data, sections = unpack_message(data, config["maxBytes"])
    handle = ec.codes_new_from_message(data)
    try:
        def value(key, getter):
            try:
                return getter(handle, key)
            except ec.CodesInternalError as error:
                raise ValueError(f"GRIB2 {key}: {error}") from error
        number = lambda key: value(key, ec.codes_get_long)
        real = lambda key: value(key, ec.codes_get_double)
        surface = lambda which: (None if ec.codes_is_missing(handle, "scaleFactorOf" + which + "FixedSurface")
                                 or ec.codes_is_missing(handle, "scaledValueOf" + which + "FixedSurface")
                                 else number("scaledValueOf" + which + "FixedSurface") * 10 ** -number("scaleFactorOf" + which + "FixedSurface"))
        width, height = number("Ni"), number("Nj")
        count = width * height
        require(number("gridDefinitionTemplateNumber") == 0, "Expected GRIB2 grid template 3.0 (regular lat/lon)")
        require(width == config["width"] and height == config["height"] and number("numberOfDataPoints") == count,
                "Split GRIB grid dimension mismatch")
        scan = number("scanningMode")
        first_lat, last_lat = real("latitudeOfFirstGridPointInDegrees"), real("latitudeOfLastGridPointInDegrees")
        require(scan in (0, 64), "Unsupported Split GRIB scanning mode")
        require(first_lat < last_lat if scan == 64 else first_lat > last_lat, "Split GRIB scanning mode disagrees with latitude endpoints")
        identification = {key: number(key) for key in ("centre", "year", "month", "day", "hour", "minute", "second")}
        reference = datetime(*(identification[key] for key in ("year", "month", "day", "hour", "minute", "second")), tzinfo=timezone.utc)
        template, coordinates = number("productDefinitionTemplateNumber"), number("NV")
        require(template in (0, 8), "Unsupported Split GRIB product definition template")
        require(number("typeOfGeneratingProcess") == 2, "Unsupported Split GRIB generating process")
        require(sections[4] == (34 if template == 0 else 58) + 4 * coordinates, "Unsupported Split GRIB product layout")
        unit = number("indicatorOfUnitOfTimeRange")
        require(unit in HOURS, "Unsupported GRIB2 time range unit code")
        start = number("forecastTime") * HOURS[unit]
        require(start >= 0, "Invalid Split GRIB forecast time")
        end, statistic = start, None
        if template == 8:
            require(number("numberOfTimeRange") == 1, "Split GRIB statistical product requires exactly one time range")
            require(number("numberOfMissingInStatisticalProcess") == 0, "Split GRIB statistical interval contains missing samples")
            require(number("typeOfTimeIncrement") == 2 and number("timeIncrement") == 0
                    and number("indicatorOfUnitForTimeIncrement") in (*HOURS, 255), "Unsupported Split GRIB statistical increment")
            unit = number("indicatorOfUnitForTimeRange")
            require(unit in HOURS, "Unsupported GRIB2 statistical time unit code")
            end_date = datetime(*(number(key + "OfEndOfOverallTimeInterval") for key in ("year", "month", "day", "hour", "minute", "second")), tzinfo=timezone.utc)
            end = (end_date - reference).total_seconds() / 3600
            duration = number("lengthOfTimeRange") * HOURS[unit]
            require(duration > 0 and abs(end - duration - start) <= 1e-6, "Split GRIB statistical endpoints and range length differ")
            statistic = number("typeOfStatisticalProcessing")
        packing, coded, bits = number("dataRepresentationTemplateNumber"), number("numberOfValues"), number("bitsPerValue")
        require(coded <= count, "GRIB2 coded value count exceeds grid point count")
        require(packing in (0, 2, 3, 40, 42), "Unsupported Split GRIB packing template")
        require(number("bitMapIndicator") in (0, 255), "Unsupported GRIB2 Section 6 bitmap indicator")
        bitmap = ec.codes_get_array(handle, "bitmap", int) if number("bitmapPresent") else None
        require(coded == (int(np.count_nonzero(bitmap)) if bitmap is not None else count), "GRIB2 coded value count differs from grid/bitmap coverage")
        if packing == 0:
            require(sections[7] >= 5 + (coded * bits + 7) // 8, "Truncated GRIB2 simple-packing payload")
        if packing == 42 and bits and coded:
            offset = number("offsetSection7") + 5
            raw = ccsds_values(data[offset:offset + sections[7] - 5], coded, bits,
                               number("ccsdsFlags"), number("ccsdsBlockSize"), number("ccsdsRsi"))
            values = raw.astype(np.float64)
            values *= 2 ** number("binaryScaleFactor")
            values += real("referenceValue")
            values *= 10 ** -number("decimalScaleFactor")
            if bitmap is not None:
                expanded = np.full(count, np.nan)
                expanded[bitmap != 0] = values
                values = expanded
        else:
            values = ec.codes_get_values(handle)
        require(len(values) == count, "Decoded GRIB2 sample count mismatch")
        selected = indices if scan == 0 else (height - 1 - indices // width) * width + indices % width
        values = values[selected]
        missing = (~np.isfinite(values)).astype(np.uint8)
        if bitmap is not None:
            missing |= (bitmap[selected] == 0)
        values[missing != 0] = np.nan
        precise = template == 8 and not target
        with np.errstate(over="ignore"):
            values = values.astype("<f8" if precise else "<f4", copy=False)
        missing |= ~np.isfinite(values)
        values[missing != 0] = np.nan
        metadata = {
            "discipline": number("discipline"), "identification": identification,
            "grid": {"kind": "latlon", "ni": width, "nj": height, "numberOfDataPoints": count,
                     "scanningMode": scan, "uvRelativeToGrid": bool(number("uvRelativeToGrid")),
                     "latitudeOfFirstGridPoint": first_lat, "latitudeOfLastGridPoint": last_lat,
                     "longitudeOfFirstGridPoint": real("longitudeOfFirstGridPointInDegrees"),
                     "longitudeOfLastGridPoint": real("longitudeOfLastGridPointInDegrees"),
                     "iDirectionIncrement": real("iDirectionIncrementInDegrees"), "jDirectionIncrement": real("jDirectionIncrementInDegrees")},
            "product": {"templateNumber": template, "coordinateValueCount": coordinates,
                        "parameterCategory": number("parameterCategory"), "parameterNumber": number("parameterNumber"),
                        "firstFixedSurfaceType": number("typeOfFirstFixedSurface"), "firstFixedSurfaceValue": surface("First"),
                        "secondFixedSurfaceType": number("typeOfSecondFixedSurface"), "secondFixedSurfaceValue": surface("Second"),
                        "validTimeIso": (reference + timedelta(hours=end)).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                        "startHour": start, "endHour": end, "statisticalProcessCode": statistic},
            "representation": {"dataRepresentationTemplateNumber": packing, "codedValueCount": coded, "bitsPerValue": bits,
                               "referenceValue": real("referenceValue"), "binaryScaleFactor": number("binaryScaleFactor"),
                               "decimalScaleFactor": number("decimalScaleFactor"),
                               "packingError": 0 if bits == 0 else 0.5 * 2 ** number("binaryScaleFactor") * 10 ** -number("decimalScaleFactor")},
            "expandedBytes": len(data), "precision": 8 if precise else 4}
        return metadata, values.tobytes() + missing.tobytes()
    finally:
        ec.codes_release(handle)


def main():
    config_size, = struct.unpack("<I", read_exact(4))
    require(config_size <= 4096, "Decoder configuration exceeds byte limit")
    config = json.loads(read_exact(config_size))
    require(0 <= config["count"] <= config["width"] * config["height"], "Invalid decoder sample count")
    indices = np.frombuffer(read_exact(config["count"] * 4), dtype="<u4")
    require(not len(indices) or int(indices.max()) < config["width"] * config["height"], "Active cell index exceeds Split GRIB grid size")
    while header := sys.stdin.buffer.read(8):
        require(len(header) == 8, "Truncated decoder request")
        length, target = struct.unpack("<II", header)
        require(0 < length <= config["maxBytes"], "Split GRIB object byte length out of bounds")
        data = read_exact(length)
        try:
            metadata, payload = decode(data, config, indices, target)
        except Exception as error:
            metadata, payload = {"error": str(error)[:4096]}, b""
        metadata["peakNativeRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
        encoded = json.dumps(metadata, allow_nan=False, separators=(",", ":")).encode()
        sys.stdout.buffer.write(struct.pack("<II", len(encoded), len(payload)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
        del data, metadata, payload, encoded


if __name__ == "__main__":
    runtime = verify_runtime()
    if sys.argv[1:] == ["--check"]:
        print(json.dumps(runtime, separators=(",", ":")))
    else:
        main()

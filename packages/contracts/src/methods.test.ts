import { INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../tests/model-fixtures.js';
import { describe, expect, it } from 'vitest';
import { LIFT_METHOD, LIFT_METHOD_PARAMETERS, METHODS, MODEL_LEVEL_LIFT_METHOD, PRECIPITATION_METHOD, PRECIPITATION_ALL_HOURS_METHOD, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_PARAMETERS, TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE, TERRAIN_COLUMN_CLOUD_METHODS_BY_VERTICAL_COORDINATE, terrainColumnMethodForProduct, createProductDescriptors, createProductMethodId, createRefinementDescriptors, createWholeDomainDescriptors, descriptorSchema, nativeMethodForLayer, NATIVE_METHODS_BY_VERTICAL_COORDINATE, NATIVE_METHOD_PARAMETERS, NORMALIZED_INPUTS, methodDescriptorSchema, getProduct } from './index.js';
import { deriveSoaringViews, NATIVE_DIAGNOSTIC_PARAMETERS } from '@av/soaring';

describe('implemented method snapshots', () => {
  it('projects source-declared interval gust maxima without changing instantaneous source snapshots', () => {
    const product = { ...INDEXED_PRODUCT, layers: [...INDEXED_PRODUCT.layers, 'wind-gust-10m' as const],
      upstream: { ...INDEXED_PRODUCT.upstream, auxSurface: { gust10mMps: { statistic: 2 } } } };
    const maximum = createProductDescriptors(product), gust = maximum.layers['wind-gust-10m']!;
    expect(gust.timeSupport).toBe('interval-maximum');
    expect(maximum.methods[gust.methodId]!.inputs.gust10mMps!.timeSupport).toBe('interval-maximum');
    const instantProduct = { ...product, upstream: { ...product.upstream, auxSurface: {} } };
    const instant = createProductDescriptors(instantProduct);
    expect(instant.layers['wind-gust-10m']!.timeSupport).toBe('valid-time');
    expect(instant.methods[gust.methodId]!.inputs.gust10mMps!.timeSupport).toBe('valid-time');
    expect(NORMALIZED_INPUTS.gust10mMps.timeSupport).toBe('valid-time');
  });

  it.each([INDEXED_PRODUCT, SPLIT_PRODUCT])('publishes $modelId whole-domain layers with their actual methods and ground references', product => {
    const descriptors = createWholeDomainDescriptors(product), legacy = createProductDescriptors(product);
    const method = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate];
    expect(descriptors.layers['usable-lift-msl']).toMatchObject({ methodId: method.id, verticalReference: 'MSL' });
    expect(descriptors.layers['usable-lift-agl']).toMatchObject({ methodId: method.id, verticalReference: 'terrain-AGL', label: 'Usable lift depth (terrain AGL)' });
    expect(descriptors.methods[method.id]).toEqual(method);
    expect(Object.keys(descriptors.methods)).toEqual(product.layers.includes('precip-rate') ? [method.id, PRECIPITATION_ALL_HOURS_METHOD.id] : [method.id]);
    if (product.layers.includes('precip-rate')) expect(descriptors.layers['precip-rate']).toEqual(legacy.layers['precip-rate']);
    expect(legacy.layers['usable-lift-agl'].verticalReference).toBe('model-AGL');
    expect(createProductMethodId(product)).toBe([...new Set(product.layers.map(layer => legacy.layers[layer].methodId))].join('+'));
    expect(descriptorSchema.parse(descriptors)).toEqual(descriptors);
  });

  it.each([INDEXED_PRODUCT, SPLIT_PRODUCT])('describes $modelId terrain-column refinement separately from its native atmospheric method and legacy clearance', product => {
    const base = createProductDescriptors(product), patch = createRefinementDescriptors(product, [1, 2, 3, 4]);
    const method = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate];
    const native = base.methods[base.layers['usable-lift-msl'].methodId];
    const pressureInput = product.capabilities.verticalCoordinate === 'model-levels' ? 'pressurePa' : 'pressureLevelsHpa';
    const otherPressureInput = pressureInput === 'pressurePa' ? 'pressureLevelsHpa' : 'pressurePa';
    expect(Object.keys(patch.layers)).toEqual(['usable-lift-msl', 'usable-lift-agl']);
    expect(patch.layers['usable-lift-msl']).toMatchObject({ methodId: method.id, verticalReference: 'MSL' });
    expect(patch.layers['usable-lift-agl']).toMatchObject({ methodId: method.id, verticalReference: 'terrain-AGL' });
    expect(patch.methods).toEqual({ [method.id]: method });
    expect(method.spatialSupport).toBe('bilinear-neighborhood');
    expect(method.outputs).toEqual(['usable-lift-msl', 'usable-lift-agl']);
    expect(patch.bounds).toEqual([1, 2, 3, 4]);
    expect(base.layers['usable-lift-agl'].verticalReference).toBe('model-AGL');
    expect(native.id).not.toBe(method.id);
    expect(method.id).not.toBe(TERRAIN_CLEARANCE_METHOD.id);
    expect(method.requiredInputs).toEqual([...native.requiredInputs, ...TERRAIN_CLEARANCE_METHOD.requiredInputs]);
    expect(method.requiredInputs).toContain(pressureInput);
    expect(method.requiredInputs).not.toContain(otherPressureInput);
    expect(method.inputs[pressureInput]).toEqual(native.inputs[pressureInput]);
    expect(method.parameters).toBe(TERRAIN_COLUMN_PARAMETERS);
    expect(method.parameters.gribQuantizationRelativeHumidityLimit).toBe(native.parameters.gribQuantizationRelativeHumidityLimit);
    expect(TERRAIN_CLEARANCE_METHOD.requiredInputs).toEqual(['convectiveDepthTopMslM', 'buoyancyM2S3', 'branch', 'terrainElevationM']);
    expect(TERRAIN_CLEARANCE_METHOD.inputs.branch).toMatchObject({ id: 'branch', quantity: 'convective-physical-support-branch', units: 'code' });
    expect(TERRAIN_CLEARANCE_METHOD.caveats[0]).toContain('both MSL and AGL outputs');
    expect(TERRAIN_CLEARANCE_METHOD.caveats[1]).toContain('All positive-weight contributors must be convective');
  });
  it('shares one lift dependency/parameter snapshot across MSL and AGL', () => {
    const descriptors = createProductDescriptors(INDEXED_PRODUCT);
    expect(Object.keys(descriptors.methods)).toEqual(['dry-lenschow-1p2-v2', 'trailing-precipitation-rate-v2']);
    expect(descriptors.layers['usable-lift-msl'].methodId).toBe(descriptors.layers['usable-lift-agl'].methodId);
    const lift = descriptors.methods['dry-lenschow-1p2-v2']!;
    expect(lift.requiredInputs).toEqual(['terrainM', 'surfacePressurePa', 'temp2mK', 'specificHumidity2mKgKg', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'pressureLevelsHpa', 'hgtM', 'tempK']);
    expect(lift.parameters).toMatchObject({ sinkRateMps: 1.2, dryLapseRateKperM: 0.0098, gravityMps2: 9.80665, saturationRelativeTolerance: 1e-6, maximumProfileGapM: 1000, maximumBisectionIterations: 60 });
    expect(lift.inputs.sensibleHeatFluxWm2).toMatchObject({ quantity: 'upward-sensible-heat-flux', units: 'W/m2', timeSupport: 'interval-mean' });
    expect(lift.inputs.tempK).toMatchObject({ units: 'K', dimensions: 'level-cell', timeSupport: 'valid-time' });
    expect(Object.isFrozen(LIFT_METHOD_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(LIFT_METHOD.requiredInputs)).toBe(true);
    expect(Object.isFrozen(LIFT_METHOD.inputs.terrainM)).toBe(true);
  });

  it('describes per-column model-level pressure and omits precipitation for ICON-EU lift-only product', () => {
    const descriptors = createProductDescriptors(SPLIT_PRODUCT);
    expect(Object.keys(descriptors.layers)).toEqual(['usable-lift-msl', 'usable-lift-agl']);
    expect(Object.keys(descriptors.methods)).toEqual(['dry-lenschow-1p2-model-levels-v2']);
    const lift = descriptors.methods[MODEL_LEVEL_LIFT_METHOD.id]!;
    expect(lift.requiredInputs).toEqual(['terrainM', 'surfacePressurePa', 'temp2mK', 'specificHumidity2mKgKg', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'pressurePa', 'hgtM', 'tempK']);
    expect(lift.inputs.pressurePa).toEqual({
      id: 'pressurePa',
      quantity: 'air-pressure',
      units: 'Pa',
      dimensions: 'level-cell',
      verticalReference: 'terrain-following model levels',
      timeSupport: 'valid-time',
      missingness: 'explicit-cell-mask'
    });
    expect(Object.isFrozen(MODEL_LEVEL_LIFT_METHOD.requiredInputs)).toBe(true);
  });

  it.each([INDEXED_PRODUCT, SPLIT_PRODUCT])('resolves every current $modelId method ID to its exact input descriptor', product => {
    const descriptors = createProductDescriptors(product);
    const ids = product.layers.map(layer => descriptors.layers[layer].methodId);
    expect(createProductMethodId(product)).toBe([...new Set(ids)].join('+'));
    for (const id of ids) expect(METHODS[id as keyof typeof METHODS]).toEqual(descriptors.methods[id]);
    expect(MODEL_LEVEL_LIFT_METHOD.id).not.toBe(LIFT_METHOD.id);
    expect(METHODS[LIFT_METHOD.id].requiredInputs).toContain('pressureLevelsHpa');
    expect(METHODS[MODEL_LEVEL_LIFT_METHOD.id].requiredInputs).toContain('pressurePa');
  });

  it('retains historic ICON snapshots under their original shared ID without rewriting their inputs', () => {
    const stored = createProductDescriptors(SPLIT_PRODUCT), historic = stored.methods[MODEL_LEVEL_LIFT_METHOD.id];
    delete stored.methods[MODEL_LEVEL_LIFT_METHOD.id];
    historic.id = LIFT_METHOD.id;
    stored.methods[LIFT_METHOD.id] = historic;
    for (const layer of Object.values(stored.layers)) layer.methodId = LIFT_METHOD.id;
    const parsed = descriptorSchema.parse(stored);
    expect(parsed).toEqual(stored);
    expect(parsed.methods[LIFT_METHOD.id].requiredInputs).toContain('pressurePa');
    expect(parsed.methods[LIFT_METHOD.id].requiredInputs).not.toContain('pressureLevelsHpa');
  });

  it('admits only the needed precipitation definition for a precipitation-only product', () => {
    const descriptors = createProductDescriptors({ ...INDEXED_PRODUCT, layers: ['precip-rate'] });
    expect(Object.keys(descriptors.methods)).toEqual(['trailing-precipitation-rate-v2']);
    expect(descriptors.methods[PRECIPITATION_ALL_HOURS_METHOD.id]?.requiredInputs).toEqual(['precipitationMmPerHour']);
    expect(Object.values(descriptors.methods[PRECIPITATION_ALL_HOURS_METHOD.id]!.inputs)).toEqual([
      { id: 'precipitationMmPerHour', quantity: 'liquid-water-equivalent-precipitation-rate', units: 'mm/h', dimensions: 'cell', verticalReference: 'surface', timeSupport: 'interval-mean', missingness: 'explicit-cell-mask' }
    ]);
  });

  it('reads a retained definition without requiring current constants, normalization or an executable kernel', () => {
    const stored = createProductDescriptors(INDEXED_PRODUCT), previous = stored.methods[LIFT_METHOD.id];
    previous.parameters.sinkRateMps = 1.3;
    previous.parameters.kelvinOffset = 0;
    previous.inputs.temp2mK.units = 'degC';
    previous.inputs.temp2mK.quantity = 'historical-temperature-convention';
    previous.id = 'retained-dry-column-v0';
    delete stored.methods[LIFT_METHOD.id];
    stored.methods[previous.id] = previous;
    stored.layers['usable-lift-msl'].methodId = previous.id;
    stored.layers['usable-lift-agl'].methodId = previous.id;
    expect(descriptorSchema.parse(stored).methods[previous.id]).toEqual(previous);
    expect(LIFT_METHOD_PARAMETERS.sinkRateMps).toBe(1.2);
  });

  it('rejects absent, misbound, incomplete or structurally invalid method descriptors', () => {
    const invalid = (mutate: (value: ReturnType<typeof JSON.parse>) => void) => {
      const descriptor = JSON.parse(JSON.stringify(createProductDescriptors(INDEXED_PRODUCT)));
      mutate(descriptor);
      expect(descriptorSchema.safeParse(descriptor).success).toBe(false);
    };
    invalid(value => { delete value.methods; });
    invalid(value => { delete value.methods[LIFT_METHOD.id]; });
    invalid(value => { value.layers['usable-lift-msl'].methodId = PRECIPITATION_METHOD.id; });
    invalid(value => { value.methods[LIFT_METHOD.id].requiredInputs.pop(); });
    invalid(value => { value.methods[LIFT_METHOD.id].requiredInputs[1] = value.methods[LIFT_METHOD.id].requiredInputs[0]; });
    invalid(value => { delete value.methods[LIFT_METHOD.id].inputs.surfacePressurePa; });
    invalid(value => { value.methods[LIFT_METHOD.id].inputs.surfacePressurePa.id = 'temp2mK'; });
    invalid(value => { value.methods[LIFT_METHOD.id].inputs.temp2mK.units = ''; });
    invalid(value => { value.methods[LIFT_METHOD.id].inputs.temp2mK.dimensions = 'unknown'; });
    invalid(value => { value.methods[LIFT_METHOD.id].parameters.sinkRateMps = NaN; });
    invalid(value => { delete value.methods[LIFT_METHOD.id].parameters; });
    invalid(value => { value.methods[LIFT_METHOD.id].parameters['unsafe parameter key'] = 1; });
  });
});

describe('native method metadata', () => {
  it.each([
    { model: 'gfs', pressure: 'pressureLevelsHpa', otherPressure: 'pressurePa', gust: 'valid-time' },
    { model: 'icon-eu', pressure: 'pressurePa', otherPressure: 'pressureLevelsHpa', gust: 'interval-maximum' },
    { model: 'rrfs', pressure: 'pressureLevelsHpa', otherPressure: 'pressurePa', gust: 'valid-time' }
  ] as const)('binds the full production $model registry to its physical inputs', ({ model, pressure, otherPressure, gust }) => {
    const product = getProduct(model);
    if (!product) throw new Error(`Missing production product: ${model}`);
    const descriptors = createWholeDomainDescriptors(product);
    expect(product.layers).toHaveLength(20);
    for (const layer of ['thermal-velocity', 'bl-mean-wind-u', 'bl-mean-wind-v'] as const) {
      const method = descriptors.methods[descriptors.layers[layer]!.methodId]!;
      expect(method.requiredInputs).toContain(pressure);
      expect(method.requiredInputs).not.toContain(otherPressure);
    }
    const layer = descriptors.layers['wind-gust-10m']!;
    expect(layer.timeSupport).toBe(gust);
    expect(descriptors.methods[layer.methodId]!.inputs.gust10mMps!.timeSupport).toBe(gust);
    expect(descriptorSchema.safeParse(descriptors).success).toBe(true);
  });

  it.each(['isobaric', 'model-levels'] as const)('binds %s pressures and every actual dependency within descriptor bounds', coordinate => {
    const methods = NATIVE_METHODS_BY_VERTICAL_COORDINATE[coordinate];
    const pressure = coordinate === 'isobaric' ? 'pressureLevelsHpa' : 'pressurePa';
    const otherPressure = coordinate === 'isobaric' ? 'pressurePa' : 'pressureLevelsHpa';
    for (const method of Object.values(methods)) {
      expect(methodDescriptorSchema.safeParse(method).success).toBe(true);
      expect(method.requiredInputs).not.toContain(otherPressure);
      expect(Object.isFrozen(method)).toBe(true);
    }
    expect(methods.soaring.requiredInputs).toContain(pressure);
    expect(methods.wind.requiredInputs).toContain(pressure);
    expect(methods.cloud.requiredInputs).not.toContain(pressure);
    for (const group of ['soaring', 'wind'] as const) {
      expect(methods[group].requiredInputs).toEqual(expect.arrayContaining(['terrainM', 'temp2mK', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'pblHeightM', 'hgtM', 'tempK']));
    }
    expect(methods.cloud.outputs).toEqual(['surface-lcl-msl']);
    expect(methods.surface.outputs).toContain('cape-jkg');
    expect(nativeMethodForLayer('precip-rate', coordinate)).toBeUndefined();
  });

  it('publishes the exact thresholds used by native physical decisions', () => {
    expect(NATIVE_METHOD_PARAMETERS).toMatchObject({
      nearSaturationSpreadC: 0.5, overdevelopmentRelativeHumidityPercent: 85,
      minimumLevelAglM: 20, mixedLayerPoissonExponent: 0.2854,
      cloudCapSinkRateMps: 1, lenschowScale: 4, lenschowShape: 0.8, lenschowPeakZeta: 0.3125
    });
    expect(NATIVE_METHOD_PARAMETERS).not.toHaveProperty('sourceWindHeightAglM');
    expect(NATIVE_METHOD_PARAMETERS).not.toHaveProperty('boundaryLayerWindAnchorAglM');
    expect(nativeMethodForLayer('bl-mean-wind-u', 'isobaric')!.caveats.join(' ')).toContain('10 m vector anchored at ground');
    for (const [key, parameter] of Object.entries(NATIVE_DIAGNOSTIC_PARAMETERS)) expect(NATIVE_METHOD_PARAMETERS).toHaveProperty(key, parameter);
    const basis = { thermalTopM: 2000, mixedLayerLclM: 1500, thermalVelocityMps: 1 };
    expect(deriveSoaringViews({ ...basis, thermalTopRhPercent: NATIVE_METHOD_PARAMETERS.overdevelopmentRelativeHumidityPercent - 0.01 }).overdeveloped).toBe(false);
    expect(deriveSoaringViews({ ...basis, thermalTopRhPercent: NATIVE_METHOD_PARAMETERS.overdevelopmentRelativeHumidityPercent }).overdeveloped).toBe(true);
  });

  it('retains exact wind height, pressure and source parcel meanings', () => {
    expect(NORMALIZED_INPUTS.u10mMps).toMatchObject({ quantity: 'eastward-wind', verticalReference: '10 m model AGL', timeSupport: 'valid-time' });
    expect(NORMALIZED_INPUTS.gust10mMps.timeSupport).toBe('valid-time');
    expect(NORMALIZED_INPUTS.capeJkg.verticalReference).toBe('source parcel declared in provenance');
  });

  it('retains the old precipitation snapshot and declares the all-hour method separately', () => {
    expect(METHODS[PRECIPITATION_METHOD.id]).toBe(PRECIPITATION_METHOD);
    expect(PRECIPITATION_METHOD.id).toBe('trailing-precipitation-rate-v1');
    expect(PRECIPITATION_METHOD.parameters).toHaveProperty('minimumSolarElevationDeg');
    expect(PRECIPITATION_METHOD.caveats[1]).toContain('daylight');
    expect(PRECIPITATION_ALL_HOURS_METHOD.id).toBe('trailing-precipitation-rate-v2');
    expect(PRECIPITATION_ALL_HOURS_METHOD.parameters).not.toHaveProperty('minimumSolarElevationDeg');
    expect(PRECIPITATION_ALL_HOURS_METHOD.caveats[1]).toContain('every retained forecast time');
    expect(methodDescriptorSchema.safeParse(PRECIPITATION_ALL_HOURS_METHOD).success).toBe(true);
  });
});


it.each([INDEXED_PRODUCT, SPLIT_PRODUCT])('versions native cloud support for $modelId while retaining the legacy terrain method', product => {
  const coordinate = product.capabilities.verticalCoordinate, legacy = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[coordinate];
  const method = TERRAIN_COLUMN_CLOUD_METHODS_BY_VERTICAL_COORDINATE[coordinate];
  expect(terrainColumnMethodForProduct(product)).toBe(legacy);
  expect(terrainColumnMethodForProduct({ ...product, layers: [...product.layers, 'thermal-velocity'] })).toBe(method);
  expect(legacy.requiredInputs).not.toContain('nativeCloudSupport');
  expect(method.requiredInputs).toEqual([...legacy.requiredInputs, 'nativeCloudSupport']);
  expect(method.inputs.nativeCloudSupport).toMatchObject({ quantity: 'native-cloud-support-flags', units: 'code', verticalReference: 'native model column' });
  expect(method.caveats).toContain('Cloud support flags combine available positive-weight native-column diagnostics.');
  expect(methodDescriptorSchema.safeParse(method).success).toBe(true);
  expect(method.parameters).toBe(legacy.parameters);
  expect(METHODS[method.id]).toBe(method);
});

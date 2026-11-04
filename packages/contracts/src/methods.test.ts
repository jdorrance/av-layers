import { describe, expect, it } from 'vitest';
import { GFS_PRODUCT, ICON_EU_PRODUCT, LIFT_METHOD, LIFT_METHOD_PARAMETERS, METHODS, MODEL_LEVEL_LIFT_METHOD, PRECIPITATION_METHOD, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_PARAMETERS, TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE, createProductDescriptors, createProductMethodId, createRefinementDescriptors, createWholeDomainDescriptors, descriptorSchema } from './index.js';

describe('implemented method snapshots', () => {
  it.each([GFS_PRODUCT, ICON_EU_PRODUCT])('publishes $modelId whole-domain layers with their actual methods and ground references', product => {
    const descriptors = createWholeDomainDescriptors(product), legacy = createProductDescriptors(product);
    const method = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate];
    expect(descriptors.layers['usable-lift-msl']).toMatchObject({ methodId: method.id, verticalReference: 'MSL' });
    expect(descriptors.layers['usable-lift-agl']).toMatchObject({ methodId: method.id, verticalReference: 'terrain-AGL', label: 'Usable lift depth (terrain AGL)' });
    expect(descriptors.methods[method.id]).toEqual(method);
    expect(Object.keys(descriptors.methods)).toEqual(product.layers.includes('precip-rate') ? [method.id, PRECIPITATION_METHOD.id] : [method.id]);
    if (product.layers.includes('precip-rate')) expect(descriptors.layers['precip-rate']).toEqual(legacy.layers['precip-rate']);
    expect(legacy.layers['usable-lift-agl'].verticalReference).toBe('model-AGL');
    expect(createProductMethodId(product)).toBe([...new Set(product.layers.map(layer => legacy.layers[layer].methodId))].join('+'));
    expect(descriptorSchema.parse(descriptors)).toEqual(descriptors);
  });

  it.each([GFS_PRODUCT, ICON_EU_PRODUCT])('describes $modelId terrain-column refinement separately from its native atmospheric method and legacy clearance', product => {
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
    const descriptors = createProductDescriptors(GFS_PRODUCT);
    expect(Object.keys(descriptors.methods)).toEqual(['dry-lenschow-1p2-v2', 'trailing-precipitation-rate-v1']);
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
    const descriptors = createProductDescriptors(ICON_EU_PRODUCT);
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

  it.each([GFS_PRODUCT, ICON_EU_PRODUCT])('resolves every current $modelId method ID to its exact input descriptor', product => {
    const descriptors = createProductDescriptors(product);
    const ids = product.layers.map(layer => descriptors.layers[layer].methodId);
    expect(createProductMethodId(product)).toBe([...new Set(ids)].join('+'));
    for (const id of ids) expect(METHODS[id as keyof typeof METHODS]).toEqual(descriptors.methods[id]);
    expect(MODEL_LEVEL_LIFT_METHOD.id).not.toBe(LIFT_METHOD.id);
    expect(METHODS[LIFT_METHOD.id].requiredInputs).toContain('pressureLevelsHpa');
    expect(METHODS[MODEL_LEVEL_LIFT_METHOD.id].requiredInputs).toContain('pressurePa');
  });

  it('retains historic ICON snapshots under their original shared ID without rewriting their inputs', () => {
    const stored = createProductDescriptors(ICON_EU_PRODUCT), historic = stored.methods[MODEL_LEVEL_LIFT_METHOD.id];
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
    const descriptors = createProductDescriptors({ ...GFS_PRODUCT, layers: ['precip-rate'] });
    expect(Object.keys(descriptors.methods)).toEqual(['trailing-precipitation-rate-v1']);
    expect(descriptors.methods[PRECIPITATION_METHOD.id]?.requiredInputs).toEqual(['precipitationMmPerHour']);
    expect(Object.values(descriptors.methods[PRECIPITATION_METHOD.id]!.inputs)).toEqual([
      { id: 'precipitationMmPerHour', quantity: 'liquid-water-equivalent-precipitation-rate', units: 'mm/h', dimensions: 'cell', verticalReference: 'surface', timeSupport: 'interval-mean', missingness: 'explicit-cell-mask' }
    ]);
  });

  it('reads a retained definition without requiring current constants, normalization or an executable kernel', () => {
    const stored = createProductDescriptors(GFS_PRODUCT), previous = stored.methods[LIFT_METHOD.id];
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
      const descriptor = JSON.parse(JSON.stringify(createProductDescriptors(GFS_PRODUCT)));
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

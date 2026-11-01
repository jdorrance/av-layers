import { describe, expect, it } from 'vitest';
import { GFS_PRODUCT, LIFT_METHOD, LIFT_METHOD_PARAMETERS, PRECIPITATION_METHOD, createProductDescriptors, descriptorSchema } from './index.js';

describe('implemented method snapshots', () => {
  it('shares one lift dependency/parameter snapshot across MSL and AGL', () => {
    const descriptors = createProductDescriptors();
    expect(Object.keys(descriptors.methods)).toEqual(['dry-lenschow-pbl-1p2-v1', 'trailing-precipitation-rate-v1']);
    expect(descriptors.layers['usable-lift-msl'].methodId).toBe(descriptors.layers['usable-lift-agl'].methodId);
    const lift = descriptors.methods['dry-lenschow-pbl-1p2-v1']!;
    expect(lift.requiredInputs).toEqual(['terrainM', 'surfacePressurePa', 'temp2mK', 'specificHumidity2mKgKg', 'pblHeightM', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'pressureLevelsHpa', 'hgtM', 'tempK']);
    expect(lift.parameters).toMatchObject({ sinkRateMps: 1.2, dryLapseRateKperM: 0.0098, gravityMps2: 9.80665, saturationRelativeTolerance: 1e-6, maximumProfileGapM: 1000, maximumBisectionIterations: 60 });
    expect(lift.inputs.sensibleHeatFluxWm2).toMatchObject({ quantity: 'upward-sensible-heat-flux', units: 'W/m2', timeSupport: 'interval-mean' });
    expect(lift.inputs.tempK).toMatchObject({ units: 'K', dimensions: 'level-cell', timeSupport: 'valid-time' });
    expect(Object.isFrozen(LIFT_METHOD_PARAMETERS)).toBe(true);
    expect(Object.isFrozen(LIFT_METHOD.requiredInputs)).toBe(true);
    expect(Object.isFrozen(LIFT_METHOD.inputs.terrainM)).toBe(true);
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
    const stored = createProductDescriptors(), previous = stored.methods[LIFT_METHOD.id];
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
      const descriptor = JSON.parse(JSON.stringify(createProductDescriptors()));
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

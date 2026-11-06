/** Registry windows resolve into forecast hours, map horizons and compute groups. */
export default {
  gfs: { hourlyThrough: 24, endHour: 72, tailStepHours: 3, minHorizonHours: 48, framesPerShard: 2 },
  'icon-eu': { hourlyThrough: 24, endHour: 72, tailStepHours: 3, minHorizonHours: 48, framesPerShard: 1 },
  rrfs: { hourlyThrough: 24, endHour: 72, tailStepHours: 3, minHorizonHours: 48, framesPerShard: 1 }
};

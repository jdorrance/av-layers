export function populateModelOptions(select: HTMLSelectElement): void {
  for (const model of ['gfs', 'hrrr', 'icon-armenia']) {
    const regional = model !== 'gfs';
    const option = new Option(regional ? `${model} (unavailable: regional coverage not implemented)` : model, model);
    option.disabled = regional;
    select.add(option);
  }
}

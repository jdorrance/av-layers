import { UPP_NORTH, UPP_SOUTH } from '../../../scripts/fixtures/upp-products.js';
import { createApp } from '../src/index';

export default createApp({
  products: Object.fromEntries([UPP_NORTH, UPP_SOUTH].map(product => [product.modelId, product]))
});

import { UPP_ARMENIA, UPP_NEW_ZEALAND } from '../../../scripts/fixtures/upp-products.js';
import { createApp } from '../src/index';

export default createApp({
  products: Object.fromEntries([UPP_ARMENIA, UPP_NEW_ZEALAND].map(product => [product.modelId, product]))
});

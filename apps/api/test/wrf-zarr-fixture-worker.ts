import { WRF_ZARR_FIXTURE } from '../../../scripts/fixtures/wrf-zarr-product.js';
import { createApp } from '../src/index';

export default createApp({ products: { [WRF_ZARR_FIXTURE.modelId]: WRF_ZARR_FIXTURE } });

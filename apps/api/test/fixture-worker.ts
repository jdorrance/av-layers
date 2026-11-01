// Selected only by `sample-preview --fixture`; production Wrangler main is unchanged.
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { createApp } from '../src/index';

export default createApp({ products: { gfs: OFFLINE_PRODUCT } });

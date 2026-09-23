import { readFile, writeFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { addressSchema } from '../src/validation.js';
import { kitePriceAmount, kiteChainByName } from '../src/kite.js';

try {
  const maintainer = process.env.GITHUB_USERNAME ?? '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(maintainer)) throw new Error('Set your actual GITHUB_USERNAME.');
  const payTo = addressSchema.parse(process.env.PAY_TO);
  const status = process.env.SERVICE_STATUS ?? 'draft';
  if (!['draft', 'testnet', 'live'].includes(status)) throw new Error('SERVICE_STATUS must be draft, testnet, or live.');
  const network = process.env.KITE_NETWORK ?? 'testnet';
  if (network !== 'testnet' && network !== 'mainnet') throw new Error('KITE_NETWORK must be testnet or mainnet.');
  const chain = kiteChainByName(network);
  const price = process.env.PRICE_USD ?? '0.001';
  kitePriceAmount(price, chain);
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Manifest PUBLIC_BASE_URL must be a public HTTPS origin.');
    }
  }
  const manifest = {
    schema: 1, name: 'kite-memory-audit', display_name: 'ERC-8350 Memory History Audit',
    description: 'Replays ERC-8350 public memory-state history against a fixed finalized block and returns checkpoint consistency checks with chain evidence. Payment settles on Kite.',
    maintainer: { github: maintainer }, status,
    ...(baseUrl ? { base_url: new URL(baseUrl).origin } : {}),
    network: chain.network, pay_to: payTo,
    upstream: { name: 'Ethereum Sepolia JSON-RPC with an in-process ERC-8350 collector', url: 'https://ethereum-sepolia-rpc.publicnode.com', requires_api_key: false },
    endpoints: [{ method: 'POST', path: '/v1/memory/audit',
      summary: 'Audit a configured memory space at a finalized block with an optional checkpoint', price_usd: price,
      example_request: { headers: { 'Content-Type': 'application/json' }, body: JSON.parse(await readFile('examples/request.json', 'utf8')) },
      pitfalls: ['Only configured registry deployments are supported.', 'Sequences and block numbers must be decimal strings.', 'Any report containing an unknown check returns 503 without settlement.', 'A complete inconsistent report with no unknown checks is a completed audit and is charged.'],
    }], categories: ['ai', 'data'], tags: ['erc-8350', 'memory', 'audit', 'x402'], source: 'custom',
  };
  const ajv = new Ajv2020({ allErrors: true });
  (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
  const validate = ajv.compile(JSON.parse(await readFile('schema/service.schema.json', 'utf8')));
  if (!validate(manifest)) throw new Error(ajv.errorsText(validate.errors));
  const output = process.argv[2] ?? 'service.json';
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote schema-valid ${output} (${status}). This validates structure, not deployment or payment evidence.`);
} catch (error) { console.error(error instanceof Error ? error.message : 'Manifest failed'); process.exitCode = 1; }

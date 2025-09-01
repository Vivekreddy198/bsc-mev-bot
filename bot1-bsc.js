import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// ====== ENV ======
const BSC_RPC = process.env.BSC_RPC;
const BLOXROUTE_KEY = process.env.BLOXROUTE_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FLASH_RECEIVER = process.env.FLASH_RECEIVER;

// ====== Providers ======
const scanProvider = new ethers.JsonRpcProvider(BSC_RPC);
const relayProvider = new ethers.JsonRpcProvider(
  `https://bsc.api.blxrbdn.com?authHeader=${BLOXROUTE_KEY}`
);
const wallet = new ethers.Wallet(PRIVATE_KEY, relayProvider);

// ====== Flash Loan Contract ======
const flashABI = [
  "function flashSwap(address tokenBorrow, uint256 amount, bytes data) external"
];
const flashContract = new ethers.Contract(FLASH_RECEIVER, flashABI, wallet);

// ====== Pancake v2 Router & Factory ======
const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const PANCAKE_V2_FACTORY = "0xBCfCcbde45cE874adCB698cC183deBcF17952812";
const routerABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
];
const pancake = new ethers.Contract(PANCAKE_V2_ROUTER, routerABI, scanProvider);

const pairABI = [
  "function getReserves() external view returns (uint112, uint112, uint32)"
];
const factoryABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];
const pancakeFactory = new ethers.Contract(PANCAKE_V2_FACTORY, factoryABI, scanProvider);

// ====== DODO Pools ======
const DODO_POOLS = {
  VAI_USDT: "0x9e0B3fF9b65E962fCb632c96AcaCf0F44C7266a5",
  HAY_BUSD: "0xD1ba9BAC957322D6e8c07a160a3A8dA11A0d2867",
  TUSD_USDT: "0xD4E2EC4D5C285D910208272dDA48a80b1dC36D7F",
  USDD_BUSD: "0x2289dB32464da04a821aF16D4351F7e02e32cAd3"
};
const dodoABI = [
  "function querySellQuoteToken(uint256 payAmount) external view returns (uint256 receiveAmount)"
];

// ====== Tokens ======
const TOKENS = {
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  BUSD: "0xe9e7cea3dedca5984780bafc599bd69add087d56",
  VAI:  "0x4BD17003473389A42DAF6a0a729f6Fdb328BbBd7",
  HAY:  "0x0782B6d8c4551b9760e74c0545A9bCD90bdc41E5",
  TUSD: "0x14016e85a25aeb13065688cafb43044c2ef86784",
  USDD: "0xd17479997F34dd9156Deef8F95A52D81D265be9c"
};

// ====== Parameters ======
const LOAN_SIZES = [10000, 50000, 100000].map(x => ethers.parseUnits(x.toString(), 18));
const MIN_PROFIT = ethers.parseUnits("25", 18); // $25 base threshold
const GAS_LIMIT = 600000n;
const MAX_GAS_PRICE = 15n * 10n ** 9n; // 15 gwei max
const COOLDOWN_MS = 30000; // 30s between trades

let lastTradeTime = 0;

// ====== Helpers ======
async function getPancakeQuote(amountIn, path) {
  try {
    const out = await pancake.getAmountsOut(amountIn, path);
    return out[out.length - 1];
  } catch {
    return 0n;
  }
}

async function getDodoQuote(pool, amountIn) {
  try {
    const dodo = new ethers.Contract(pool, dodoABI, scanProvider);
    return await dodo.querySellQuoteToken(amountIn);
  } catch {
    return 0n;
  }
}

async function getLiquidityDepth(tokenA, tokenB) {
  try {
    const pairAddress = await pancakeFactory.getPair(tokenA, tokenB);
    if (pairAddress === ethers.ZeroAddress) return 0n;
    const pair = new ethers.Contract(pairAddress, pairABI, scanProvider);
    const [reserve0, reserve1] = await pair.getReserves();
    return reserve0 + reserve1;
  } catch {
    return 0n;
  }
}

function logProfit(message) {
  const line = `${new Date().toISOString()} | ${message}\n`;
  fs.appendFileSync("profit-log.txt", line);
  console.log(line);
}

// ====== Scanner for each pair (both directions) ======
async function checkPair(name, tokenA, tokenB, dodoPool, loanSize) {
  // 1. Check liquidity
  const reserves = await getLiquidityDepth(tokenA, tokenB);
  if (reserves < loanSize * 2n) {
    console.log(`❌ [${name}] Skipped - not enough liquidity`);
    return;
  }

  // 2. Pancake -> DODO
  const out1 = await getPancakeQuote(loanSize, [tokenA, tokenB]);
  const out2 = await getDodoQuote(dodoPool, out1);
  await evaluateTrade(name, tokenA, tokenB, loanSize, out2, "Pancake→DODO");

  // 3. DODO -> Pancake (reverse direction)
  const out3 = await getDodoQuote(dodoPool, loanSize);
  const out4 = await getPancakeQuote(out3, [tokenB, tokenA]);
  await evaluateTrade(name, tokenB, tokenA, loanSize, out4, "DODO→Pancake");
}

// ====== Evaluate Trade ======
async function evaluateTrade(name, tokenIn, tokenOut, loanSize, finalOut, direction) {
  if (finalOut <= loanSize) return;

  const profit = finalOut - loanSize;
  const feeData = await relayProvider.getFeeData();
  const gasPrice = feeData.gasPrice || 5n * 10n ** 9n;

  if (gasPrice > MAX_GAS_PRICE) {
    console.log(`⏸ [${name}] Gas too high: ${gasPrice / 1e9} gwei`);
    return;
  }

  const estGasCost = gasPrice * GAS_LIMIT;
  if (profit <= (estGasCost * 2n) + MIN_PROFIT) return;

  // Cooldown
  const now = Date.now();
  if (now - lastTradeTime < COOLDOWN_MS) {
    console.log("⏸ Skipping trade due to cooldown");
    return;
  }
  lastTradeTime = now;

  logProfit(`✅ ${direction} ${name} | Loan: ${ethers.formatUnits(loanSize, 18)} | Profit: ${ethers.formatUnits(profit, 18)} | GasPrice: ${gasPrice / 1e9} gwei`);

  const abiCoder = new ethers.AbiCoder();
  const data = abiCoder.encode(
    ["address[]","address[]","address[]","address[]"],
    [[tokenIn, tokenOut], [tokenOut, tokenIn], [], [PANCAKE_V2_ROUTER]]
  );

  try {
    const tx = await flashContract.flashSwap(
      tokenIn,
      loanSize,
      data,
      { gasLimit: Number(GAS_LIMIT) }
    );
    console.log("🚀 Sent tx:", tx.hash);
    logProfit(`Tx Hash: ${tx.hash}`);
  } catch (err) {
    console.error("❌ Tx failed:", err.reason || err);
  }
}

// ====== Main Scan Loop ======
async function scan() {
  for (const loanSize of LOAN_SIZES) {
    await checkPair("VAI/USDT", TOKENS.USDT, TOKENS.VAI, DODO_POOLS.VAI_USDT, loanSize);
    await checkPair("HAY/BUSD", TOKENS.BUSD, TOKENS.HAY, DODO_POOLS.HAY_BUSD, loanSize);
    await checkPair("TUSD/USDT", TOKENS.USDT, TOKENS.TUSD, DODO_POOLS.TUSD_USDT, loanSize);
    await checkPair("USDD/BUSD", TOKENS.BUSD, TOKENS.USDD, DODO_POOLS.USDD_BUSD, loanSize);
  }
}

setInterval(scan, 20000); // scan every 20s

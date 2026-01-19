// ==========================================
// Crypto Tracker Backend (Node.js + Express)
// ==========================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Connection, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- 配置區 ---
// Solana 連線 (Mainnet)
const solanaConnection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// 幣種對應 CoinGecko API ID
const COIN_GECKO_IDS = {
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'SOL': 'solana',
    'ADA': 'cardano'
};

// --- 鏈處理邏輯 (Chain Handlers) ---
const chainHandlers = {
    
    // 1. Bitcoin (支援 XPUB, Address, Taproot)
    BTC: async (rawAddress) => {
        // 清洗輸入：移除前後與中間所有空白/換行
        const address = rawAddress.trim().replace(/\s/g, '');

        // 基本格式檢查 (僅允許 Base58 英數字符)
        if (/[^a-zA-Z0-9]/.test(address)) {
             return { chain: 'BTC', address: rawAddress, error: "地址包含非法字元 (請重新複製，勿含標點或特殊符號)" };
        }

        try {
            // 判斷是否為 XPUB (Ledger 母鑰)
            const isXpub = address.match(/^(xpub|ypub|zpub|vpub|upub)/i);

            if (isXpub) {
                // XPUB: 使用 Blockchain.info API
                const { data } = await axios.get(`https://blockchain.info/multiaddr?active=${address}&n=5`);
                const balanceBtc = data.wallet.final_balance / 100000000;
                
                const transactions = data.txs.slice(0, 5).map(tx => ({
                    hash: tx.hash,
                    value: "XPUB Activity",
                    date: new Date(tx.time * 1000).toLocaleDateString(),
                    type: "MIXED"
                }));
                return { chain: 'BTC', address, balance: balanceBtc, transactions };

            } else {
                // 單一地址: 使用 Blockstream API
                const { data: addressInfo } = await axios.get(`https://blockstream.info/api/address/${address}`);
                const { data: txsData } = await axios.get(`https://blockstream.info/api/address/${address}/txs`);

                // 計算餘額 (包含未確認交易 Mempool)
                const balanceSat = (addressInfo.chain_stats.funded_txo_sum - addressInfo.chain_stats.spent_txo_sum) +
                                   (addressInfo.mempool_stats.funded_txo_sum - addressInfo.mempool_stats.spent_txo_sum);
                
                const balanceBtc = balanceSat / 100000000;

                const transactions = txsData.slice(0, 5).map(tx => ({
                    hash: tx.txid,
                    value: (tx.status.confirmed) ? "Confirmed" : "Pending...",
                    date: tx.status.block_time ? new Date(tx.status.block_time * 1000).toLocaleDateString() : "Mempool",
                    type: "TX"
                }));
                return { chain: 'BTC', address, balance: balanceBtc, transactions };
            }
        } catch (e) {
            if (e.response && e.response.status === 400) return { chain: 'BTC', address, error: "格式錯誤 (請確認是有效 XPUB 或地址)" };
            return { chain: 'BTC', address, error: "查詢失敗 (API 限制或無效地址)" };
        }
    },

    // 2. Ethereum (Balance + Mock Txs)
    ETH: async (address) => {
        try {
            // 使用 Blockscout API 查餘額
            const { data } = await axios.get(`https://eth.blockscout.com/api?module=account&action=balance&address=${address}`);
            const balanceEth = parseInt(data.result) / 1e18;
            return { chain: 'ETH', address, balance: balanceEth, transactions: [] }; 
        } catch (e) {
            return { chain: 'ETH', address, error: "查詢失敗 (Check Address)" };
        }
    },

    // 3. Solana (Official Web3.js)
    SOL: async (address) => {
        try {
            const pubKey = new PublicKey(address);
            const balanceLamports = await solanaConnection.getBalance(pubKey);
            const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

            const signatures = await solanaConnection.getSignaturesForAddress(pubKey, { limit: 5 });
            const transactions = signatures.map(sig => ({
                hash: sig.signature,
                value: "Solana Action",
                date: new Date(sig.blockTime * 1000).toLocaleDateString(),
                type: sig.err ? 'Fail' : 'Success'
            }));
            return { chain: 'SOL', address, balance: balanceSol, transactions };
        } catch (e) {
            return { chain: 'SOL', address, error: "無效 SOL 地址" };
        }
    },

    // 4. Cardano (ADA - Payment & Stake Address)
    ADA: async (address) => {
        try {
            const isStake = address.startsWith('stake1');
            let balanceAda = 0;
            let transactions = [];

            // A. 取得餘額
            try {
                const url = isStake ? 'account_info' : 'address_info';
                const body = isStake ? { _stake_addresses: [address] } : { _addresses: [address] };
                const { data } = await axios.post(`https://api.koios.rest/api/v1/${url}`, body);
                
                if (data && data.length > 0) {
                    const bal = isStake ? data[0].total_balance : data[0].balance;
                    balanceAda = parseInt(bal || 0) / 1000000;
                }
            } catch (err) { console.error("ADA Balance Error"); }

            // B. 取得交易 (容錯處理，避免 404 導致整個崩潰)
            try {
                const urlTx = isStake ? 'account_txs' : 'address_txs';
                const bodyTx = isStake ? { _stake_addresses: [address] } : { _addresses: [address] };
                const { data: txs } = await axios.post(`https://api.koios.rest/api/v1/${urlTx}`, bodyTx);
                
                if (txs) {
                    transactions = txs.slice(0, 5).map(tx => ({
                        hash: tx.tx_hash,
                        value: "ADA Tx",
                        date: tx.block_time ? new Date(tx.block_time * 1000).toLocaleDateString() : "Pending",
                        type: "TX"
                    }));
                }
            } catch (err) {
                transactions = [{ hash: "", value: "API 暫時無法讀取歷史", date: "Info", type: "INFO" }];
            }

            return { chain: 'ADA', address, balance: balanceAda, transactions };
        } catch (e) {
            return { chain: 'ADA', address, error: "查詢嚴重錯誤" };
        }
    }
};

// --- 主要 API Endpoint ---
app.post('/api/portfolio', async (req, res) => {
    const { wallets } = req.body;
    if (!wallets || !Array.isArray(wallets)) return res.status(400).json({ error: "Invalid input" });

    try {
        // 1. 並行查詢所有錢包餘額
        const promises = wallets.map(wallet => {
            const handler = chainHandlers[wallet.chain];
            return handler ? handler(wallet.address) : Promise.resolve({ ...wallet, error: "Unsupported Chain" });
        });
        const walletResults = await Promise.all(promises);

        // 2. 查詢當前幣價 (CoinGecko)
        // 過濾出成功的鏈並去重複
        const uniqueChains = [...new Set(walletResults.filter(w => !w.error).map(w => w.chain))];
        const geckoIds = uniqueChains.map(c => COIN_GECKO_IDS[c]).join(',');
        
        let prices = {};
        if (geckoIds) {
            try {
                const { data } = await axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
                    params: { ids: geckoIds, vs_currencies: 'usd,eur,chf' }
                });
                prices = data;
            } catch (e) { console.error("Price API Error:", e.message); }
        }

        // 3. 計算總價值並整合回傳
        const finalResults = walletResults.map(item => {
            if (item.error) return item;
            
            const geckoId = COIN_GECKO_IDS[item.chain];
            const p = prices[geckoId] || { usd: 0, eur: 0, chf: 0 };
            
            return {
                ...item,
                price: p, // 單價
                value: {  // 總價值
                    usd: item.balance * p.usd,
                    eur: item.balance * p.eur,
                    chf: item.balance * p.chf
                }
            };
        });

        res.json(finalResults);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server Error" });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
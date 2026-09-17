/** OrphanDust fixed-price unlock credit helpers. */
const crypto=require('crypto');
const RECEIVE='0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';
const SKUS={od_unlock_050:{price_usdc:'0.50',credits:1},od_credits_1:{price_usdc:'1.00',credits:1},od_credits_2:{price_usdc:'3.00',credits:2},od_credits_3:{price_usdc:'5.00',credits:3}};
function baseUrl(req){const h=(req&&req.headers&&(req.headers['x-forwarded-host']||req.headers.host))||'dualregistry.dev';return `https://${h}`;}
function getSku(sku){const x=SKUS[String(sku||'')];return x?{...x,sku}:null;}
function catalogBody(req){return {product:'OrphanDust',skus:Object.entries(SKUS).map(([sku,x])=>({sku,...x})),receive_wallet:RECEIVE,catalog:`${baseUrl(req)}/ORPHANDUST.json`};}
function buildSkuInvoice(row,req,extra){return {status:402,type:'x402_payment_required',sku:row.sku,amount:row.price_usdc,amount_usdc:row.price_usdc,credits:row.credits,receive_wallet:RECEIVE,pay_to:RECEIVE,...extra};}
function parsePaymentProof(req,url){const h=req.headers||{};const tx=h['x-payment-tx']||h['payment-tx']||(url&&url.searchParams.get('tx_hash'));if(!tx||!/^0x[0-9a-fA-F]{64}$/.test(tx))return null;return {tx_hash:tx,chain:h['x-payment-chain']||(url&&url.searchParams.get('chain'))||'base',asset:(h['x-payment-asset']||(url&&url.searchParams.get('asset'))||'USDC').toUpperCase(),amount:h['x-payment-amount']||(url&&url.searchParams.get('amount'))};}
function amountsMatch(a,b){return Math.abs(parseFloat(a)-parseFloat(b))<0.0001;}
function completePurchase({skuRow,agent_id,payment}){const token=`odc_${crypto.randomBytes(18).toString('hex')}`;return {ok:true,sku:skuRow.sku,credits:skuRow.credits,credit_token:token,agent_id,payment};}
function extractCreditToken(req,body,url){return (body&&(body.credit_token||body.creditToken))||(req&&req.headers&&(req.headers['x-credit-token']||req.headers['X-CREDIT-TOKEN']))||(url&&url.searchParams.get('credit_token'))||null;}
function consumeCredit(){return {ok:false,reason:'credit_ledger_unavailable'};}
module.exports={RECEIVE,SKUS,getSku,catalogBody,buildSkuInvoice,parsePaymentProof,amountsMatch,completePurchase,extractCreditToken,consumeCredit,baseUrl};

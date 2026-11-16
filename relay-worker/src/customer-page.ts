export const customerPage = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A sua conta</title><style>
:root{color-scheme:dark;font-family:Georgia,serif;background:#111b1a;color:#edf1e6}body{margin:0}main{max-width:800px;margin:auto;padding:clamp(24px,7vw,72px)}header{border-bottom:1px solid #50635c;padding-bottom:30px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:#b1c9ae}h1{font-weight:400;font-size:clamp(36px,7vw,64px);margin:14px 0}h2{font-size:24px;font-weight:400;margin:40px 0 12px}p,li{line-height:1.5}ul{padding:0;list-style:none}li{display:flex;justify-content:space-between;gap:20px;border-top:1px solid #40534a;padding:16px 0;font:16px system-ui}small{color:#b9c8b8;font:14px system-ui}.error{color:#ffcab7}strong{font-weight:600}footer{margin-top:48px;border-top:1px solid #40534a;padding-top:20px}
</style></head><body><main><header><div class="eyebrow">Área do cliente</div><h1>A sua conta</h1><p id="intro">A carregar…</p></header><div id="content" hidden><section><h2>Faturas em aberto</h2><p id="balance"></p><ul id="invoices"></ul></section><section><h2>Serviços</h2><ul id="services"></ul></section><footer><small id="updated"></small></footer></div><p id="error" class="error" role="alert"></p></main><script src="/customer-portal.js" defer></script></body></html>`;

// The decryption key is in the URL fragment and is never sent to the worker.
export const customerScript = `(() => {
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  const decode = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-s.length%4)%4)), c=>c.charCodeAt(0));
  // O mesmo formato do ISPM (shared/money.ts): 2.500$00.
  const money = n => { const a=Math.abs(Math.round(n)); return (n<0?'-':'')+String(Math.trunc(a/100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+'$'+String(a%100).padStart(2,'0'); };
  const day = s => /^\\d{4}-\\d{2}-\\d{2}/.test(s||'') ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : (s||'');
  const add = (id, left, right) => { const li=document.createElement('li'), a=document.createElement('span'), b=document.createElement('strong'); a.textContent=left; b.textContent=right; li.append(a,b); document.getElementById(id).append(li); };
  async function run() {
    const key = location.hash.slice(1);
    if(!/^[A-Za-z0-9_-]{43}$/.test(key)) throw Error('O link está incompleto. Peça um novo link ao seu operador.');
    const response=await fetch(location.pathname+'/snapshot',{cache:'no-store',referrerPolicy:'no-referrer'});
    if(!response.ok) throw Error('Este link expirou ou já não está disponível. Peça um novo link ao seu operador.');
    const data=await response.json(); if(data.expiresAt<=Date.now()) throw Error('Este link expirou.');
    const e=data.envelope, cipher=decode(e.ciphertext), tag=decode(e.tag), input=new Uint8Array(cipher.length+tag.length); input.set(cipher); input.set(tag,cipher.length);
    const cryptoKey=await crypto.subtle.importKey('raw',decode(key),'AES-GCM',false,['decrypt']);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(e.nonce),additionalData:new TextEncoder().encode('ispm-customer-portal:1'),tagLength:128},cryptoKey,input);
    const snapshot=JSON.parse(new TextDecoder().decode(plain));
    text('intro',snapshot.customerName+' · '+snapshot.customerCode);
    text('balance','Total em aberto: '+money(snapshot.invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0)));
    for(const invoice of snapshot.invoices) add('invoices',(invoice.number || 'Fatura')+' · vence a '+day(invoice.dueDate),money(invoice.balanceCents));
    if(!snapshot.invoices.length) add('invoices','Não há faturas em aberto.','');
    if(snapshot.creditCents>0) add('invoices','Crédito disponível',money(snapshot.creditCents));
    const labels={active:'Ativo',suspended:'Suspenso',cancelled:'Cancelado'};
    for(const service of snapshot.services) add('services',service.plan || 'Serviço',labels[service.status] || service.status);
    if(!snapshot.services.length) add('services','Não há serviços ativos.','');
    text('updated','Informação atualizada em '+new Date(snapshot.generatedAt).toLocaleString('pt-PT',{timeZone:'Atlantic/Cape_Verde'})+'. Os dados podem ter mudado desde então.');
    document.getElementById('content').hidden=false;
  }
  run().catch(error => { text('intro',''); text('error',error instanceof Error && error.message.startsWith('O link') || error instanceof Error && error.message.startsWith('Este link') ? error.message : 'Não foi possível abrir a conta. Peça um novo link ao seu operador.'); });
})();`;

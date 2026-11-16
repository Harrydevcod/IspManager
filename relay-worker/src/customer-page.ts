export const customerPage = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>A sua conta</title><style>
:root{color-scheme:dark;font-family:Georgia,serif;background:#111b1a;color:#edf1e6}body{margin:0}main{max-width:800px;margin:auto;padding:clamp(24px,7vw,72px)}header{border-bottom:1px solid #50635c;padding-bottom:30px}.eyebrow{font:600 12px system-ui;letter-spacing:.18em;text-transform:uppercase;color:#b1c9ae}h1{font-weight:400;font-size:clamp(36px,7vw,64px);margin:14px 0}h2{font-size:24px;font-weight:400;margin:40px 0 12px}p,li{line-height:1.5}ul{padding:0;list-style:none}li{display:flex;justify-content:space-between;gap:20px;border-top:1px solid #40534a;padding:16px 0;font:16px system-ui}small{color:#b9c8b8;font:14px system-ui}.error{color:#ffcab7}strong{font-weight:600}footer{margin-top:48px;border-top:1px solid #40534a;padding-top:20px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding-bottom:28px;margin-bottom:28px;border-bottom:1px solid #40534a}.parties:empty{display:none}.party{display:flex;flex-direction:column;gap:2px;min-width:0;overflow-wrap:anywhere}.party:last-child{text-align:right}.party strong{font:600 17px system-ui}.label{font:600 11px system-ui;letter-spacing:.16em;text-transform:uppercase;color:#8fa79a;margin-bottom:6px}a{color:#d6e8cf;text-decoration-color:#6f877b;text-underline-offset:3px}#intro:empty,.contact:empty{display:none}.contact{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;margin:0 0 16px;font:15px system-ui}.pay{margin-bottom:20px}.pay .label{margin:0}.pay li strong{font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap}@media(max-width:560px){.parties{grid-template-columns:1fr}.party:last-child{text-align:left}.pay li{flex-direction:column;gap:4px}}
</style></head><body><main><header><div id="parties" class="parties"></div><div class="eyebrow">Área do cliente</div><h1>A sua conta</h1><p id="intro">A carregar…</p></header><div id="content" hidden><section><h2>Faturas em aberto</h2><p id="balance"></p><ul id="invoices"></ul></section><section><h2>Serviços</h2><ul id="services"></ul></section><footer><div id="pay" class="pay" hidden><div class="label">Pagamento por transferência</div><ul id="banks"></ul></div><p id="contact" class="contact"></p><small id="updated"></small></footer></div><p id="error" class="error" role="alert"></p></main><script src="/customer-portal.js" defer></script></body></html>`;

// The decryption key is in the URL fragment and is never sent to the worker.
export const customerScript = `(() => {
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  const decode = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-s.length%4)%4)), c=>c.charCodeAt(0));
  // O mesmo formato do ISPM (shared/money.ts): 2.500$00.
  const money = n => { const a=Math.abs(Math.round(n)); return (n<0?'-':'')+String(Math.trunc(a/100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+'$'+String(a%100).padStart(2,'0'); };
  const day = s => /^\\d{4}-\\d{2}-\\d{2}/.test(s||'') ? s.slice(8,10)+'/'+s.slice(5,7)+'/'+s.slice(0,4) : (s||'');
  const add = (id, left, right, sub) => { const li=document.createElement('li'), a=document.createElement('span'), b=document.createElement('strong'); a.textContent=left; if(sub){ const s=document.createElement('small'); s.textContent=sub; a.append(document.createElement('br'), s); } b.textContent=right; li.append(a,b); document.getElementById(id).append(li); };
  const el = (tag, cls, value) => { const n=document.createElement(tag); if(cls) n.className=cls; if(value) n.textContent=value; return n; };
  // Emitente e cliente lado a lado, como numa fatura. Cada linha vazia fica de fora.
  const party = (title, name, lines) => { const d=el('div','party'); d.append(el('div','label',title), el('strong','',name)); for(const line of lines.filter(Boolean)) d.append(el('small','',line)); document.getElementById('parties').append(d); };
  const link = (href, value) => { const a=el('a','',value); a.href=href; return a; };
  async function run() {
    const fragment = location.hash.slice(1), utf8 = v => new TextEncoder().encode(v);
    let snapshotPath, rawKey;
    if(/^[A-Za-z0-9_-]{22}$/.test(fragment)) {
      // Link curto (/c#segredo): o id e a chave saem do segredo, como no ISPM (customer-portal-crypto.ts).
      const id=[...new Uint8Array(await crypto.subtle.digest('SHA-256',utf8('ispm-portal-id:'+fragment)))].map(b=>b.toString(16).padStart(2,'0')).join('');
      const ikm=await crypto.subtle.importKey('raw',decode(fragment),'HKDF',false,['deriveBits']);
      rawKey=new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(0),info:utf8('ispm-portal-key')},ikm,256));
      snapshotPath='/customer/'+id+'/snapshot';
    } else if(/^[A-Za-z0-9_-]{43}$/.test(fragment)) {
      // Links emitidos antes do link curto: id no caminho, chave no fragmento.
      rawKey=decode(fragment); snapshotPath=location.pathname+'/snapshot';
    } else throw Error('O link está incompleto. Peça um novo link ao seu operador.');
    const response=await fetch(snapshotPath,{cache:'no-store',referrerPolicy:'no-referrer'});
    if(!response.ok) throw Error('Este link expirou ou já não está disponível. Peça um novo link ao seu operador.');
    const data=await response.json(); if(data.expiresAt<=Date.now()) throw Error('Este link expirou.');
    const e=data.envelope, cipher=decode(e.ciphertext), tag=decode(e.tag), input=new Uint8Array(cipher.length+tag.length); input.set(cipher); input.set(tag,cipher.length);
    const cryptoKey=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(e.nonce),additionalData:utf8('ispm-customer-portal:1'),tagLength:128},cryptoKey,input);
    const snapshot=JSON.parse(new TextDecoder().decode(plain));
    const company=snapshot.company || {};
    // Instantâneos anteriores não traziam a empresa: mostra-se só o cliente, como antes.
    if(company.name) party('Prestador',company.name,[company.nif && 'NIF '+company.nif,[company.address,company.island].filter(Boolean).join(' · ')]);
    party('Cliente',snapshot.customerName,['Cliente '+snapshot.customerCode, snapshot.customerNif && 'NIF '+snapshot.customerNif, snapshot.customerAddress]);
    text('intro','');
    const contact=document.getElementById('contact');
    if(company.name) contact.append(el('strong','',company.name));
    if(/^[0-9+ ]{6,}$/.test(company.phone||'')) contact.append(link('tel:'+company.phone.split(' ').join(''),company.phone));
    if(/^[^ @]+@[^ @]+$/.test(company.email||'')) contact.append(link('mailto:'+company.email,company.email));
    for(const account of snapshot.bankAccounts || []) add('banks',[account.bank,account.holder].filter(Boolean).join(' · '),account.account,account.reference && 'Referência '+account.reference);
    document.getElementById('pay').hidden=!(snapshot.bankAccounts || []).length;
    text('balance','Total em aberto: '+money(snapshot.invoices.reduce((sum, invoice) => sum + invoice.balanceCents, 0)));
    for(const invoice of snapshot.invoices) add('invoices',[invoice.number || 'Fatura', invoice.period].filter(Boolean).join(' · '),money(invoice.balanceCents),[invoice.services && invoice.services[0].toUpperCase()+invoice.services.slice(1), 'vence a '+day(invoice.dueDate)].filter(Boolean).join(' · '));
    if(!snapshot.invoices.length) add('invoices','Não há faturas em aberto.','');
    if(snapshot.creditCents>0) add('invoices','Crédito disponível',money(snapshot.creditCents));
    const labels={active:'Ativo',suspended:'Suspenso',cancelled:'Cancelado'};
    for(const service of snapshot.services) add('services',service.plan ? 'Internet '+service.plan : 'Serviço',labels[service.status] || service.status);
    if(!snapshot.services.length) add('services','Não há serviços ativos.','');
    text('updated','Informação atualizada em '+new Date(snapshot.generatedAt).toLocaleString('pt-PT',{timeZone:'Atlantic/Cape_Verde'})+'. Os dados podem ter mudado desde então.');
    document.getElementById('content').hidden=false;
  }
  run().catch(error => { text('intro',''); text('error',error instanceof Error && error.message.startsWith('O link') || error instanceof Error && error.message.startsWith('Este link') ? error.message : 'Não foi possível abrir a conta. Peça um novo link ao seu operador.'); });
})();`;

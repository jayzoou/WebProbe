// Fixed, application-owned scripts. Strings keep Node/tsx transform helpers out
// of the browser realm. No website/model text is interpolated as executable JS.
const selector = String.raw`function target(el) {
 const test = el.getAttribute('data-testid'); if(test) return {by:'testId',value:test};
 if(el.id) return {by:'css',value:'#'+CSS.escape(el.id)};
 const label=el.getAttribute('aria-label');if(label)return {by:'label',value:label};
 const parts=[];let n=el;
 while(n&&n!==document.body){const tag=n.tagName.toLowerCase();const siblings=Array.from(n.parentElement?.children||[]).filter(e=>e.tagName===n.tagName);parts.unshift(tag+(siblings.length>1?':nth-of-type('+(siblings.indexOf(n)+1)+')':''));n=n.parentElement;}
 return {by:'css',value:'body > '+parts.join(' > ')};
}`;
export const inventoryScript = `(() => { ${selector}
 return Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="searchbox"],[data-testid],h1,h2,[role="status"]')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}).slice(0,100).map(el=>({target:target(el),tag:el.tagName.toLowerCase(),text:(el.textContent||'').trim().slice(0,150),label:el.getAttribute('aria-label')||el.getAttribute('placeholder')||'',type:el.getAttribute('type')||'',name:el.getAttribute('name')||'',href:el.closest('a')?.href||''}));
})()`;
export const recordingScript = `(() => { if(window!==window.top)return; ${selector}
 const send=data=>{void window.__webprobeRecord(data);};
 const secret=el=>/password|token|secret|密码|密钥|credit|cvv|cardnumber/i.test([el.type,el.name,el.autocomplete].join(' '));
 document.addEventListener('click',e=>{if(!e.isTrusted)return;const el=e.target?.closest('button,a,input,select,textarea,[role="button"]');if(el&&!secret(el))send({action:'click',target:target(el)});},true);
 const changed=e=>{if(!e.isTrusted)return;const el=e.target;if(!el||!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)||secret(el))return;if(el.tagName==='SELECT')send({action:'select',target:target(el),value:el.value});else if(['checkbox','radio'].includes(el.type))send({action:'check',target:target(el),checked:el.checked});else send({action:'fill',target:target(el),value:el.value});};
 document.addEventListener('input',changed,true);document.addEventListener('change',changed,true);
 document.addEventListener('keydown',e=>{if(!e.isTrusted||!['Enter','Tab','Escape','ArrowDown','ArrowUp'].includes(e.key))return;const el=e.target;if(el&&el!==document.body&&!secret(el))send({action:'press',target:target(el),key:e.key});},true);
})()`;

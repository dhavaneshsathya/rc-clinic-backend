/**
 * Rukmani Clinic Cloudflare Worker API starter.
 * IMPORTANT: deploy in Razorpay TEST mode first. This is a starter implementation,
 * not a substitute for end-to-end testing or professional security review.
 */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const fail = (message, status = 400) => json({ ok: false, error: message }, status);
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0; for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i); return out === 0;
}
function normalizePhone(value) {
  const raw = String(value || '').replace(/[\s()-]/g, '');
  if (/^\d{10}$/.test(raw)) return '+91' + raw;
  if (/^\+91\d{10}$/.test(raw)) return raw;
  throw new Error('Enter a valid Indian mobile number with 10 digits or +91.');
}
function validateBooking(b) {
  const services = { 'General consultation': 60, 'Follow-up consultation': 30 };
  if (!b || !services[b.service]) throw new Error('Choose a valid consultation type.');
  if (!['Online','In-clinic'].includes(b.mode)) throw new Error('Choose Online or In-clinic.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw new Error('Choose a valid date.');
  if (!/^(?:09|1\d):(?:00|30)$/.test(b.time || '') || b.time === '19:30') throw new Error('Choose a valid appointment time.');
  const d = new Date(`${b.date}T${b.time}:00+05:30`);
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + 5 * 60 * 1000) throw new Error('Choose a future appointment time.');
  if (d.getUTCDay() === 0) throw new Error('The clinic is closed on Sundays.');
  const name = String(b.name || '').trim();
  if (name.length < 2 || name.length > 100) throw new Error('Enter your full name.');
  const phone = normalizePhone(b.phone);
  const email = String(b.email || '').trim().slice(0,150);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const age = b.age === '' || b.age == null ? null : Number(b.age);
  if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) throw new Error('Enter a valid age.');
  return { service:b.service, duration:services[b.service], mode:b.mode, date:b.date, time:b.time, name, phone, email, age, reason:String(b.reason || '').trim().slice(0,500), amountPaise:49900 };
}
async function razorpay(env, path, init = {}) {
  const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const res = await fetch(`https://api.razorpay.com/v1${path}`, { ...init, headers: { authorization:`Basic ${auth}`, 'content-type':'application/json', ...(init.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.description || 'Payment provider request failed.');
  return data;
}
async function requireStaff(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const session = await env.SESSIONS.get(`staff:${token}`);
  return Boolean(session);
}
async function sendOtp(env, phone, code) {
  const url = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const body = new URLSearchParams({ To: phone, Channel: 'sms' });
  const res = await fetch(url, { method:'POST', headers:{ authorization:`Basic ${auth}`, 'content-type':'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error('Could not send SMS verification. Check the SMS provider configuration and try again.');
}
async function checkOtp(env, phone, code) {
  const url = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const body = new URLSearchParams({ To: phone, Code: code });
  const res = await fetch(url, { method:'POST', headers:{ authorization:`Basic ${auth}`, 'content-type':'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.status === 'approved';
}
export default {
 async fetch(request, env) {
  const origin = request.headers.get('origin');
  if (origin && origin !== env.APP_ORIGIN) return fail('Origin not allowed.', 403);
  if (request.method === 'OPTIONS') return new Response(null, { status:204, headers:{ 'access-control-allow-origin':env.APP_ORIGIN, 'access-control-allow-methods':'GET,POST,OPTIONS', 'access-control-allow-headers':'Content-Type,Authorization', 'access-control-max-age':'86400' } });
  const headers = { ...JSON_HEADERS, 'access-control-allow-origin':env.APP_ORIGIN, 'vary':'Origin' };
  const respond = (data,status=200) => new Response(JSON.stringify(data),{status,headers});
  const url = new URL(request.url);
  try {
   if (!env.DB || !env.SESSIONS || !env.APP_ORIGIN) {
  return respond({
    ok: false,
    error: 'Backend is not fully configured.',
    diagnostics: {
      DB: !!env.DB,
      SESSIONS: !!env.SESSIONS,
      APP_ORIGIN: !!env.APP_ORIGIN
    }
  }, 503);
}
   if (request.method === 'POST' && url.pathname === '/api/create-order') {
    const input = validateBooking(await request.json());
    // Server-side slot collision check; D1 remains the source of truth for confirmed bookings.
    const conflict = await env.DB.prepare("SELECT id FROM bookings WHERE date=? AND time=? AND status IN ('paid_pending_confirmation','confirmed') LIMIT 1").bind(input.date,input.time).first();
    if (conflict) return respond({ok:false,error:'That time is no longer available. Please choose another slot.'},409);
    const draftToken = randomToken();
    const order = await razorpay(env, '/orders', { method:'POST', body:JSON.stringify({ amount:input.amountPaise, currency:'INR', receipt:`ruk_${crypto.randomUUID().replace(/-/g,'').slice(0,20)}`, notes:{ clinic:'Rukmani Clinic', booking_token:draftToken } }) });
    await env.SESSIONS.put(`draft:${draftToken}`, JSON.stringify(input), { expirationTtl: 1800 });
    return respond({ok:true,keyId:env.RAZORPAY_KEY_ID,amount:order.amount,currency:order.currency,orderId:order.id,bookingToken:draftToken});
   }
   if (request.method === 'POST' && url.pathname === '/api/verify-payment') {
    const body = await request.json();
    const token = String(body.bookingToken || '');
    const draftRaw = await env.SESSIONS.get(`draft:${token}`);
    if (!draftRaw) return respond({ok:false,error:'Booking session expired. Contact the clinic before attempting another payment.'},410);
    const draft = JSON.parse(draftRaw);
    const orderId = String(body.razorpay_order_id || ''); const paymentId = String(body.razorpay_payment_id || ''); const signature = String(body.razorpay_signature || '');
    const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
    if (!orderId || !paymentId || !constantTimeEqual(expected, signature)) return respond({ok:false,error:'Payment signature verification failed.'},400);
    const payment = await razorpay(env, `/payments/${encodeURIComponent(paymentId)}`);
    if (payment.order_id !== orderId || payment.status !== 'captured' || payment.amount !== 49900 || payment.currency !== 'INR') return respond({ok:false,error:'Payment is not captured or amount does not match.'},402);
    const order = await razorpay(env, `/orders/${encodeURIComponent(orderId)}`);
    if (order.status !== 'paid') return respond({ok:false,error:'The payment provider has not marked this order as paid yet.'},402);
    const duplicate = await env.DB.prepare('SELECT id FROM bookings WHERE payment_id=?').bind(paymentId).first();
    if (duplicate) return respond({ok:true,bookingId:duplicate.id,status:'paid_pending_confirmation',duplicate:true});
    const id = `RKC-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    try {
      await env.DB.prepare(`INSERT INTO bookings (id,service,duration,mode,date,time,name,phone,email,age,reason,amount_paise,payment_id,order_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
       .bind(id,draft.service,draft.duration,draft.mode,draft.date,draft.time,draft.name,draft.phone,draft.email,draft.age,draft.reason,draft.amountPaise,paymentId,orderId,'paid_pending_confirmation',new Date().toISOString()).run();
    } catch (e) { return respond({ok:false,error:'Payment was verified, but the slot could not be saved. Do not pay again. Contact the clinic with payment ID '+paymentId+'.'},409); }
    await env.SESSIONS.delete(`draft:${token}`);
    // Optional signed Google Sheets mirror. D1 remains the primary record if Sheets is temporarily unavailable.
    let sheetsSync='not_configured';
    if(env.GOOGLE_SCRIPT_URL && env.GOOGLE_SCRIPT_SECRET){
      const payload=JSON.stringify({event:'booking.created',booking:{id,service:draft.service,duration:draft.duration,mode:draft.mode,date:draft.date,time:draft.time,name:draft.name,phone:draft.phone,email:draft.email,age:draft.age,amountPaise:draft.amountPaise,paymentId,orderId,status:'paid_pending_confirmation',createdAt:new Date().toISOString()}});
      const sig=await hmacHex(env.GOOGLE_SCRIPT_SECRET,payload);
      try { const sr=await fetch(env.GOOGLE_SCRIPT_URL+(env.GOOGLE_SCRIPT_URL.includes('?')?'&':'?')+'signature='+sig,{method:'POST',headers:{'content-type':'application/json'},body:payload}); sheetsSync=sr.ok?'sent':'failed'; } catch (_) { sheetsSync='failed'; }
    }
    return respond({ok:true,bookingId:id,status:'paid_pending_confirmation',sheetsSync,message:'Payment verified. Your appointment is awaiting clinic confirmation.'});
   }
   if (request.method === 'POST' && url.pathname === '/api/patient/otp/start') {
    const b = await request.json(); const phone = normalizePhone(b.phone);
    // Rate limits should be configured at Cloudflare WAF/Rate Limiting before public launch.
    const url2 = `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`;
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const res = await fetch(url2,{method:'POST',headers:{authorization:`Basic ${auth}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:phone,Channel:'sms'})});
    if (!res.ok) return respond({ok:false,error:'Could not send SMS code. Check the phone number and try again.'},502);
    return respond({ok:true,message:'Check your SMS for a verification code.'});
   }
   if (request.method === 'POST' && url.pathname === '/api/patient/otp/verify') {
    const b = await request.json(); const phone = normalizePhone(b.phone); const code = String(b.code || '').trim();
    if (!/^\d{4,8}$/.test(code)) return respond({ok:false,error:'Enter the SMS verification code.'},400);
    const approved = await checkOtp(env,phone,code); if (!approved) return respond({ok:false,error:'Code is invalid or expired.'},401);
    const result = await env.DB.prepare('SELECT id,service,mode,date,time,amount_paise,status,meet_url FROM bookings WHERE phone=? ORDER BY date DESC,time DESC LIMIT 50').bind(phone).all();
    return respond({ok:true,bookings:(result.results||[]).map(b=>({id:b.id,service:b.service,mode:b.mode,date:b.date,time:b.time,amountPaise:b.amount_paise,status:b.status,meetUrl:b.meet_url||null}))});
   }
   if (request.method === 'POST' && url.pathname === '/api/staff/login') {
    const b = await request.json();
    if (!env.STAFF_USERNAME || !env.STAFF_PASSWORD || b.username !== env.STAFF_USERNAME || !constantTimeEqual(String(b.password||''),env.STAFF_PASSWORD)) return respond({ok:false,error:'Invalid username or password.'},401);
    const token = randomToken(); await env.SESSIONS.put(`staff:${token}`,'1',{expirationTtl:28800});
    return respond({ok:true,token});
   }
   if (request.method === 'GET' && url.pathname === '/api/staff/bookings') {
    if (!await requireStaff(request,env)) return respond({ok:false,error:'Staff sign-in required.'},401);
    const result = await env.DB.prepare('SELECT id,service,mode,date,time,name,phone,email,amount_paise,status,meet_url FROM bookings ORDER BY date DESC,time DESC LIMIT 300').all();
    return respond({ok:true,bookings:(result.results||[]).map(b=>({id:b.id,service:b.service,mode:b.mode,date:b.date,time:b.time,name:b.name,phone:b.phone,email:b.email,amountPaise:b.amount_paise,status:b.status,meetUrl:b.meet_url||null}))});
   }
   if (request.method === 'POST' && url.pathname === '/api/staff/booking-status') {
    if (!await requireStaff(request,env)) return respond({ok:false,error:'Staff sign-in required.'},401);
    const b = await request.json(); if (!['paid_pending_confirmation','confirmed','cancelled'].includes(b.status)) return respond({ok:false,error:'Invalid booking status.'},400);
    const result = await env.DB.prepare('UPDATE bookings SET status=? WHERE id=?').bind(b.status,String(b.bookingId||'')).run();
    if (!result.meta.changes) return respond({ok:false,error:'Booking not found.'},404);
    return respond({ok:true});
   }

   if (request.method === 'GET' && url.pathname === '/api/doctor-profile') {
    const profile = await env.DB.prepare('SELECT name,qualifications,specialty,experience,bio,photo_url FROM doctor_profile WHERE id=1').first();
    return respond({ok:true,profile:profile?{name:profile.name,qualifications:profile.qualifications,specialty:profile.specialty,experience:profile.experience,bio:profile.bio,photoUrl:profile.photo_url}:null});
   }
   if (request.method === 'POST' && url.pathname === '/api/staff/doctor-profile') {
    if (!await requireStaff(request,env)) return respond({ok:false,error:'Staff sign-in required.'},401);
    const b=await request.json(); const name=String(b.name||'').trim();
    if(name.length<2||name.length>100) return respond({ok:false,error:'Enter a valid doctor name.'},400);
    let photoUrl=null;
    if(b.photoData){
      if(!env.ASSETS) return respond({ok:false,error:'Photo storage is not configured yet. Create the R2 bucket and binding.'},503);
      if(!['image/jpeg','image/png','image/webp'].includes(b.photoType)) return respond({ok:false,error:'Unsupported photo type.'},400);
      const raw=atob(String(b.photoData)); if(raw.length>2*1024*1024) return respond({ok:false,error:'Photo must be 2 MB or smaller.'},413);
      const bytes=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
      const ext=b.photoType==='image/jpeg'?'jpg':b.photoType==='image/png'?'png':'webp'; const key='doctor/portrait.'+ext;
      await env.ASSETS.put(key,bytes,{httpMetadata:{contentType:b.photoType,cacheControl:'public, max-age=3600'}});
      // R2 is private by default; set ASSET_PUBLIC_BASE to the public custom-domain URL for this bucket.
      if(!env.ASSET_PUBLIC_BASE) return respond({ok:false,error:'Photo stored but ASSET_PUBLIC_BASE is not configured. Configure a public asset domain before saving the profile.'},503);
      photoUrl=env.ASSET_PUBLIC_BASE.replace(/\/$/,'')+'/'+key;
    } else {
      const old=await env.DB.prepare('SELECT photo_url FROM doctor_profile WHERE id=1').first(); photoUrl=old?.photo_url||null;
    }
    await env.DB.prepare(`INSERT INTO doctor_profile (id,name,qualifications,specialty,experience,bio,photo_url,updated_at) VALUES (1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,qualifications=excluded.qualifications,specialty=excluded.specialty,experience=excluded.experience,bio=excluded.bio,photo_url=excluded.photo_url,updated_at=excluded.updated_at`).bind(name,String(b.qualifications||'').slice(0,150),String(b.specialty||'').slice(0,120),String(b.experience||'').slice(0,80),String(b.bio||'').slice(0,700),photoUrl,new Date().toISOString()).run();
    return respond({ok:true});
   }
   return respond({ok:false,error:'Not found.'},404);
  } catch (e) { return respond({ok:false,error:e.message || 'Server error.'},500); }
 }
};

const encoder = new TextEncoder();
const json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) } });
const fail = (message, status = 400) => json({ error: message }, { status });
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const money = value => {
  const n = Number(value); if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) !== n * 100) throw Error('المبلغ غير صالح');
  return Math.round(n * 100);
};
const nonnegativeMoney = value => { const n=Number(value); if(!Number.isFinite(n)||n<0||Math.round(n*100)!==n*100) throw Error('قيمة التعاقد غير صالحة'); return Math.round(n*100); };
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
// Kept below the Pages Functions CPU budget; the login throttle further limits
// password guesses. Store the work factor with each hash for future upgrades.
const PBKDF2_ITERATIONS = 10000;
async function passwordHash(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${btoa(String.fromCharCode(...salt))}$${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}
async function verifyPassword(password, stored) {
  const [type, iterations, salt64, hash64] = stored.split('$'); if (type !== 'pbkdf2') return false;
  const salt = Uint8Array.from(atob(salt64), c => c.charCodeAt(0));
  const candidate = await passwordHash(password, salt, Number(iterations));
  const a = encoder.encode(candidate), b = encoder.encode(stored); if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b) : a.every((v, i) => v === b[i]);
}
function cookie(request, name) { return request.headers.get('Cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1); }
function cookieHeader(token, maxAge = 60 * 60 * 24 * 8) { return `nh_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`; }
async function audit(env, actor, action, type, entity, metadata = {}) { await env.DB.prepare('INSERT INTO audit_logs (id,actor_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?,?)').bind(id(), actor, action, type, entity, JSON.stringify(metadata)).run(); }
async function userFromRequest(request, env) {
  const token = cookie(request, 'nh_session'); if (!token) return null;
  return env.DB.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`).bind(await digest(token)).first();
}
const requireUser = async (request, env, role) => { const user = await userFromRequest(request, env); if (!user || !user.active) throw new Response('غير مصرح', { status: 401 }); if (role && user.role !== role) throw new Response('ممنوع', { status: 403 }); return user; };
async function body(request) { try { return await request.json(); } catch { throw Error('بيانات الطلب غير صالحة'); } }
async function bootstrap(env) {
  const count = await env.DB.prepare('SELECT COUNT(*) count FROM users').first();
  if (count.count || !env.BOOTSTRAP_ADMIN_USERNAME || !env.BOOTSTRAP_ADMIN_PASSWORD) return;
  const userId = id(); await env.DB.prepare('INSERT INTO users (id,username,display_name,password_hash,role) VALUES (?,?,?,?,?)').bind(userId, env.BOOTSTRAP_ADMIN_USERNAME, 'مالك الشركة', await passwordHash(env.BOOTSTRAP_ADMIN_PASSWORD), 'admin').run();
  await audit(env, userId, 'bootstrap_admin_created', 'user', userId);
}
async function loginThrottle(request, env, username) {
  const ip=request.headers.get('CF-Connecting-IP') || 'unknown'; const key=await digest(`${ip}:${username.toLowerCase()}`);
  const recent=await env.DB.prepare("SELECT COUNT(*) count FROM login_attempts WHERE identifier_hash=? AND succeeded=0 AND attempted_at > datetime('now','-15 minutes')").bind(key).first();
  if(recent.count>=5) throw new Response('محاولات كثيرة، حاول لاحقاً', {status:429});
  return key;
}
async function assignedProject(env, engineer, project) { return env.DB.prepare(`SELECT p.id,p.name FROM projects p JOIN project_assignments a ON a.project_id=p.id WHERE p.id=? AND a.engineer_id=? AND a.unassigned_at IS NULL AND p.status='active' AND p.archived_at IS NULL`).bind(project, engineer).first(); }
async function balances(env, engineerId) {
  return env.DB.prepare(`SELECT
    COALESCE((SELECT SUM(CASE WHEN kind='handover' THEN amount_piastres ELSE -amount_piastres END) FROM advances WHERE engineer_id=? AND voided_at IS NULL),0) advances,
    COALESCE((SELECT SUM(amount_piastres) FROM expenses WHERE engineer_id=? AND status='approved'),0) approved,
    COALESCE((SELECT SUM(amount_piastres) FROM expenses WHERE engineer_id=? AND status IN ('pending','returned','cancellation_requested')),0) pending`).bind(engineerId, engineerId, engineerId).first();
}
async function dashboard(env, user) {
  if (user.role === 'engineer') {
    const b = await balances(env, user.id); const projects = await env.DB.prepare(`SELECT p.id,p.name,p.status FROM projects p JOIN project_assignments a ON a.project_id=p.id WHERE a.engineer_id=? AND a.unassigned_at IS NULL AND p.archived_at IS NULL`).bind(user.id).all();
    const expenses = await env.DB.prepare(`SELECT e.id,e.public_id,e.amount_piastres,e.status,e.submitted_at,p.name project_name,c.name_ar category FROM expenses e JOIN projects p ON p.id=e.project_id JOIN expense_categories c ON c.id=e.category_id WHERE e.engineer_id=? ORDER BY e.submitted_at DESC LIMIT 12`).bind(user.id).all();
    return { balance: { actual_piastres: b.advances - b.approved, pending_piastres: b.pending, estimated_piastres: b.advances - b.approved - b.pending }, projects: projects.results, expenses: expenses.results };
  }
  // Start the administration experience without blocking it on summary reads.
  // The management endpoints are independent and remain fully functional.
  return { overview: { active_projects: 0, clients: 0, payments: 0, expenses: 0, outstanding: 0, pending_expenses: 0, pending_advances: 0, pending_cancellations: 0 }, queue: [] };
}
async function createExpense(request, env, user) {
  const form = await request.formData(), projectId = String(form.get('project_id') || ''), category = String(form.get('category_id') || ''), submissionKey = String(form.get('submission_key') || '');
  if (!submissionKey || submissionKey.length < 16) return fail('تعذر تأكيد الطلب، أعد المحاولة');
  if (!await assignedProject(env, user.id, projectId)) return fail('المشروع غير متاح لك', 403);
  const amount = money(form.get('amount')), description = String(form.get('description') || '').trim().slice(0, 500), noReceiptReason = String(form.get('no_receipt_reason') || '').trim().slice(0, 300);
  const categoryOk = await env.DB.prepare('SELECT id FROM expense_categories WHERE id=? AND active=1').bind(category).first(); if (!categoryOk) return fail('التصنيف غير صالح');
  // If the engineer marks the expense as having no receipt, deliberately
  // ignore a previously selected file. This keeps the form usable before R2
  // object storage is enabled and avoids an upload attempt to an absent binding.
  const uploadedFiles = form.getAll('receipts').filter(x => x instanceof File && x.size);
  const files = noReceiptReason ? [] : uploadedFiles;
  if (!files.length && !noReceiptReason) return fail('أرفق إيصالاً أو اذكر سبب عدم توفره');
  if (files.length && !env.RECEIPTS) return fail('رفع صور الإيصالات غير متاح حاليًا؛ اختر «لا يوجد إيصال» واكتب السبب، أو فعّل تخزين الملفات لاحقًا');
  if (files.length > 4) return fail('الحد الأقصى 4 صور');
  for (const file of files) if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) return fail('الإيصال يجب أن يكون JPG أو PNG أو WebP وبحجم أقل من 5MB');
  const existing = await env.DB.prepare('SELECT id,public_id FROM expenses WHERE submission_key=?').bind(submissionKey).first(); if (existing) return json({ expense: existing, duplicate: true });
  const expenseId = id(), publicId = `EXP-${Date.now().toString(36).toUpperCase()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0,4).toUpperCase()}`;
  const stmts = [env.DB.prepare('INSERT INTO expenses (id,public_id,engineer_id,project_id,category_id,amount_piastres,description,no_receipt_reason,submission_key) VALUES (?,?,?,?,?,?,?,?,?)').bind(expenseId, publicId, user.id, projectId, category, amount, description || null, noReceiptReason || null, submissionKey), env.DB.prepare('INSERT INTO expense_history (id,expense_id,to_status,note,actor_id) VALUES (?,?,?,?,?)').bind(id(), expenseId, 'pending', 'تم الإرسال للمراجعة', user.id)];
  await env.DB.batch(stmts);
  for (const file of files) { const attachmentId=id(), key=`expenses/${expenseId}/${attachmentId}.${file.type.split('/')[1]}`; await env.RECEIPTS.put(key, file.stream(), { httpMetadata:{contentType:file.type}, customMetadata:{expenseId} }); await env.DB.prepare('INSERT INTO expense_attachments (id,expense_id,object_key,content_type,bytes) VALUES (?,?,?,?,?)').bind(attachmentId,expenseId,key,file.type,file.size).run(); }
  await audit(env,user.id,'expense_submitted','expense',expenseId,{publicId,amount}); return json({ expense:{id:expenseId,public_id:publicId,status:'pending'} },{status:201});
}
async function decideExpense(request, env, admin, expenseId) {
  const input=await body(request), action=input.action, note=String(input.note||'').trim().slice(0,500); const e=await env.DB.prepare('SELECT * FROM expenses WHERE id=?').bind(expenseId).first(); if(!e) return fail('المصروف غير موجود',404);
  if(action==='approve' && e.status==='pending') { await env.DB.batch([env.DB.prepare("UPDATE expenses SET status='approved',decided_at=?,decided_by=?,decision_note=? WHERE id=?").bind(now(),admin.id,note||null,e.id),env.DB.prepare('INSERT INTO expense_history (id,expense_id,from_status,to_status,note,actor_id) VALUES (?,?,?,?,?,?)').bind(id(),e.id,'pending','approved',note,admin.id)]); }
  else if(action==='reject' && ['pending','returned'].includes(e.status) && note) { await env.DB.batch([env.DB.prepare("UPDATE expenses SET status='rejected',decided_at=?,decided_by=?,decision_note=? WHERE id=?").bind(now(),admin.id,note,e.id),env.DB.prepare('INSERT INTO expense_history (id,expense_id,from_status,to_status,note,actor_id) VALUES (?,?,?,?,?,?)').bind(id(),e.id,e.status,'rejected',note,admin.id)]); }
  else if(action==='return' && e.status==='pending' && note) { await env.DB.batch([env.DB.prepare("UPDATE expenses SET status='returned',decided_at=?,decided_by=?,decision_note=? WHERE id=?").bind(now(),admin.id,note,e.id),env.DB.prepare('INSERT INTO expense_history (id,expense_id,from_status,to_status,note,actor_id) VALUES (?,?,?,?,?,?)').bind(id(),e.id,'pending','returned',note,admin.id)]); }
  else return fail('الإجراء أو الحالة غير صالحين'); await audit(env,admin.id,`expense_${action}`,'expense',e.id,{note}); return json({ok:true});
}
async function csvReport(env) {
  const [clients, projects, engineers, payments, advances, expenses] = await Promise.all([
    env.DB.prepare('SELECT id,name,phone,email,created_at FROM clients WHERE archived_at IS NULL ORDER BY created_at DESC').all(),
    env.DB.prepare('SELECT id,name,address,contract_piastres,status,created_at FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC').all(),
    env.DB.prepare("SELECT id,display_name,username,created_at FROM users WHERE role='engineer' ORDER BY created_at DESC").all(),
    env.DB.prepare('SELECT id,project_id,amount_piastres,paid_on,reference,notes,created_at FROM client_payments WHERE voided_at IS NULL ORDER BY created_at DESC').all(),
    env.DB.prepare('SELECT id,engineer_id,amount_piastres,kind,occurred_on,notes,created_at FROM advances WHERE voided_at IS NULL ORDER BY created_at DESC').all(),
    env.DB.prepare('SELECT public_id,engineer_id,project_id,category_id,amount_piastres,description,status,submitted_at,decided_at FROM expenses ORDER BY submitted_at DESC').all()
  ]);
  const rows = [['Type','ID','Name / Description','Related ID','Amount EGP','Status / Category','Date','Notes']];
  const add = (type, id, name, related, amount, status, date, notes) => rows.push([type,id,name,related,amount,status,date,notes]);
  clients.results.forEach(x => add('Client',x.id,x.name,x.phone,'','',x.created_at,x.email));
  projects.results.forEach(x => add('Project',x.id,x.name,x.address,(Number(x.contract_piastres)/100).toFixed(2),x.status,x.created_at,''));
  engineers.results.forEach(x => add('Engineer',x.id,x.display_name,x.username,'','',x.created_at,''));
  payments.results.forEach(x => add('Client payment',x.id,'',x.project_id,(Number(x.amount_piastres)/100).toFixed(2),'received',x.paid_on,[x.reference,x.notes].filter(Boolean).join(' | ')));
  advances.results.forEach(x => add(x.kind==='return'?'Cash returned':'Cash advance',x.id,'',x.engineer_id,(Number(x.amount_piastres)/100).toFixed(2),x.kind,x.occurred_on,x.notes));
  expenses.results.forEach(x => add('Expense',x.public_id,x.description,x.project_id,(Number(x.amount_piastres)/100).toFixed(2),`${x.status} / ${x.category_id}`,x.submitted_at,x.engineer_id));
  const escapeCsv = value => '"' + String(value === null || value === undefined ? '' : value).split('"').join('""') + '"';
  const content = '\uFEFF' + rows.map(row => row.map(escapeCsv).join(',')).join('\r\n');
  return new Response(content, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="new-home-financial-report.csv"', 'cache-control': 'no-store' } });
}
async function reportData(env) {
  const [clients, projects, engineers, payments, advances, expenses] = await Promise.all([
    env.DB.prepare('SELECT id,name,phone,email,created_at FROM clients WHERE archived_at IS NULL ORDER BY created_at DESC').all(),
    env.DB.prepare(`SELECT p.id,p.name,p.address,p.contract_piastres,p.status,p.created_at,c.name client_name FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.archived_at IS NULL ORDER BY p.created_at DESC`).all(),
    env.DB.prepare("SELECT id,display_name,username,created_at FROM users WHERE role='engineer' ORDER BY created_at DESC").all(),
    env.DB.prepare(`SELECT cp.id,p.name project_name,cp.amount_piastres,cp.paid_on,cp.reference,cp.notes FROM client_payments cp JOIN projects p ON p.id=cp.project_id WHERE cp.voided_at IS NULL ORDER BY cp.paid_on DESC`).all(),
    env.DB.prepare(`SELECT a.id,u.display_name engineer_name,a.kind,a.amount_piastres,a.occurred_on,a.notes FROM advances a JOIN users u ON u.id=a.engineer_id WHERE a.voided_at IS NULL ORDER BY a.occurred_on DESC`).all(),
    env.DB.prepare(`SELECT e.public_id,u.display_name engineer_name,p.name project_name,c.name_ar category,e.description,e.amount_piastres,e.status,e.submitted_at,e.decided_at FROM expenses e JOIN users u ON u.id=e.engineer_id JOIN projects p ON p.id=e.project_id JOIN expense_categories c ON c.id=e.category_id ORDER BY e.submitted_at DESC`).all()
  ]);
  return { generated_at: now(), clients: clients.results, projects: projects.results, engineers: engineers.results, payments: payments.results, advances: advances.results, expenses: expenses.results };
}
// CSV opens directly in Excel. Avoid a heavyweight XLSX library, which can
// exceed Pages Functions runtime limits and cause Cloudflare Error 1101.
async function xlsxReport(env) { return csvReport(env); }
export default { async fetch(request, env) { try { await bootstrap(env); const url=new URL(request.url), path=url.pathname.replace(/^\/api\/?/,'/'); if(!url.pathname.startsWith('/api/')) return fail('Not found',404);
  if(path==='/auth/login'&&request.method==='POST'){ const {username,password}=await body(request),loginName=String(username||'').trim(),throttle=await loginThrottle(request,env,loginName); const u=await env.DB.prepare('SELECT * FROM users WHERE username=? AND active=1').bind(loginName).first(); if(!u||!await verifyPassword(String(password||''),u.password_hash)){await env.DB.prepare('INSERT INTO login_attempts (id,identifier_hash) VALUES (?,?)').bind(id(),throttle).run();return fail('اسم المستخدم أو كلمة المرور غير صحيحين',401)} const token=crypto.randomUUID()+crypto.randomUUID(),sid=id(); await env.DB.batch([env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,datetime(\'now\',\'+8 days\'))').bind(sid,u.id,await digest(token)),env.DB.prepare('DELETE FROM login_attempts WHERE identifier_hash=?').bind(throttle)]); await audit(env,u.id,'login','session',sid); return json({user:{id:u.id,name:u.display_name,role:u.role}},{headers:{'set-cookie':cookieHeader(token)}}); }
  if(path==='/auth/logout'&&request.method==='POST'){const token=cookie(request,'nh_session');if(token)await env.DB.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=?').bind(await digest(token)).run();return json({ok:true},{headers:{'set-cookie':cookieHeader('',0)}})}
  if(path==='/auth/me'){const u=await requireUser(request,env);return json({user:u});}
  if(path==='/dashboard'){const u=await requireUser(request,env);return json(await dashboard(env,u));}
  if(path==='/projects'&&request.method==='GET'){const u=await requireUser(request,env);const q=u.role==='engineer'?`SELECT p.id,p.name,p.status FROM projects p JOIN project_assignments a ON a.project_id=p.id WHERE a.engineer_id=? AND a.unassigned_at IS NULL AND p.archived_at IS NULL`:`SELECT p.id,p.name,p.status,c.name client_name FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.archived_at IS NULL`;const r=await env.DB.prepare(q).bind(...(u.role==='engineer'?[u.id]:[])).all();return json({projects:r.results});}
  if(path==='/admin/options'&&request.method==='GET'){await requireUser(request,env,'admin');const [clients,engineers,projects]=await Promise.all([env.DB.prepare('SELECT id,name,phone FROM clients WHERE archived_at IS NULL ORDER BY name').all(),env.DB.prepare("SELECT id,display_name,username FROM users WHERE role='engineer' AND active=1 ORDER BY display_name").all(),env.DB.prepare('SELECT p.id,p.name,c.name client_name FROM projects p JOIN clients c ON c.id=p.client_id WHERE p.archived_at IS NULL ORDER BY p.name').all()]);return json({clients:clients.results,engineers:engineers.results,projects:projects.results});}
  if(path==='/expenses'&&request.method==='POST'){const u=await requireUser(request,env,'engineer');return createExpense(request,env,u);}
  const decision=path.match(/^\/expenses\/([^/]+)\/decision$/);if(decision&&request.method==='POST'){const u=await requireUser(request,env,'admin');return decideExpense(request,env,u,decision[1]);}
  if(path==='/advance-requests'&&request.method==='POST'){const u=await requireUser(request,env,'engineer');const x=await body(request),requestId=id();await env.DB.prepare('INSERT INTO advance_requests (id,engineer_id,amount_piastres,reason) VALUES (?,?,?,?)').bind(requestId,u.id,money(x.amount),String(x.reason||'').slice(0,500)).run();await audit(env,u.id,'advance_requested','advance_request',requestId);return json({id:requestId},{status:201});}
  if(path==='/users'&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),userId=id(),username=String(x.username||'').trim(),name=String(x.display_name||'').trim(),password=String(x.password||'');if(!/^[a-zA-Z0-9_.-]{3,48}$/.test(username)||!name||password.length<12)return fail('أدخل اسم مستخدم صالحاً وكلمة مرور لا تقل عن 12 حرفاً');await env.DB.prepare("INSERT INTO users (id,username,display_name,password_hash,role) VALUES (?,?,?,?, 'engineer')").bind(userId,username,name,await passwordHash(password)).run();await audit(env,u.id,'engineer_created','user',userId);return json({id:userId},{status:201});}
  if(path==='/clients'&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),clientId=id(),name=String(x.name||'').trim(),phone=String(x.phone||'').trim();if(!name||!phone)return fail('اسم العميل ورقم الهاتف مطلوبان');await env.DB.prepare('INSERT INTO clients (id,name,phone,email,notes,created_by) VALUES (?,?,?,?,?,?)').bind(clientId,name.slice(0,200),phone.slice(0,40),String(x.email||'').trim().slice(0,200)||null,String(x.notes||'').trim().slice(0,1000)||null,u.id).run();await audit(env,u.id,'client_created','client',clientId);return json({id:clientId},{status:201});}
  if(path==='/projects'&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),projectId=id(),client=String(x.client_id||'');if(!client||!String(x.name||'').trim())return fail('العميل واسم المشروع مطلوبان');const exists=await env.DB.prepare('SELECT id FROM clients WHERE id=? AND archived_at IS NULL').bind(client).first();if(!exists)return fail('العميل غير موجود');await env.DB.prepare('INSERT INTO projects (id,client_id,name,address,contract_piastres,start_date,status,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?)').bind(projectId,client,String(x.name).trim().slice(0,200),String(x.address||'').trim().slice(0,500)||null,nonnegativeMoney(x.contract_piastres||0),String(x.start_date||'')||null,['active','completed','suspended'].includes(x.status)?x.status:'active',String(x.notes||'').trim().slice(0,1000)||null,u.id).run();await audit(env,u.id,'project_created','project',projectId);return json({id:projectId},{status:201});}
  const assignment=path.match(/^\/projects\/([^/]+)\/assignments$/);if(assignment&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),engineer=await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='engineer' AND active=1").bind(String(x.engineer_id||'')).first();if(!engineer)return fail('المهندس غير صالح');await env.DB.prepare('INSERT OR REPLACE INTO project_assignments (project_id,engineer_id,assigned_by,assigned_at,unassigned_at) VALUES (?,?,?,CURRENT_TIMESTAMP,NULL)').bind(assignment[1],engineer.id,u.id).run();await audit(env,u.id,'engineer_assigned','project',assignment[1],{engineerId:engineer.id});return json({ok:true});}
  if(path==='/payments'&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),paymentId=id();await env.DB.prepare('INSERT INTO client_payments (id,project_id,amount_piastres,paid_on,reference,notes,created_by) VALUES (?,?,?,?,?,?,?)').bind(paymentId,String(x.project_id||''),money(x.amount),String(x.paid_on||now().slice(0,10)),String(x.reference||'').slice(0,200)||null,String(x.notes||'').slice(0,500)||null,u.id).run();await audit(env,u.id,'client_payment_recorded','client_payment',paymentId);return json({id:paymentId},{status:201});}
  if(path==='/advances'&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),advanceId=id(),kind=x.kind==='return'?'return':'handover';const engineer=await env.DB.prepare("SELECT id FROM users WHERE id=? AND role='engineer'").bind(String(x.engineer_id||'')).first();if(!engineer)return fail('المهندس غير صالح');await env.DB.prepare('INSERT INTO advances (id,engineer_id,amount_piastres,kind,occurred_on,notes,processed_by) VALUES (?,?,?,?,?,?,?)').bind(advanceId,engineer.id,money(x.amount),kind,String(x.occurred_on||now().slice(0,10)),String(x.notes||'').slice(0,500)||null,u.id).run();await audit(env,u.id,kind==='handover'?'advance_handed_over':'advance_returned','advance',advanceId);return json({id:advanceId},{status:201});}
  const advanceDecision=path.match(/^\/advance-requests\/([^/]+)\/decision$/);if(advanceDecision&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),status=x.action==='approve'?'approved':x.action==='reject'?'rejected':null;if(!status)return fail('الإجراء غير صالح');const r=await env.DB.prepare("UPDATE advance_requests SET status=?,decided_at=?,decided_by=?,decision_note=? WHERE id=? AND status='pending'").bind(status,now(),u.id,String(x.note||'').slice(0,500)||null,advanceDecision[1]).run();if(!r.meta.changes)return fail('الطلب غير متاح',409);await audit(env,u.id,`advance_request_${status}`,'advance_request',advanceDecision[1]);return json({ok:true});}
  const cancellation=path.match(/^\/expenses\/([^/]+)\/cancellation$/);if(cancellation&&request.method==='POST'){const u=await requireUser(request,env,'engineer');const x=await body(request),e=await env.DB.prepare('SELECT * FROM expenses WHERE id=? AND engineer_id=?').bind(cancellation[1],u.id).first();if(!e||!['pending','approved','returned'].includes(e.status))return fail('لا يمكن طلب إلغاء هذا المصروف');const requestId=id(),reason=String(x.reason||'').trim();if(!reason)return fail('سبب الإلغاء مطلوب');await env.DB.batch([env.DB.prepare('INSERT INTO cancellation_requests (id,expense_id,requested_by,reason) VALUES (?,?,?,?)').bind(requestId,e.id,u.id,reason.slice(0,500)),env.DB.prepare("UPDATE expenses SET status='cancellation_requested' WHERE id=?").bind(e.id),env.DB.prepare('INSERT INTO expense_history (id,expense_id,from_status,to_status,note,actor_id) VALUES (?,?,?,?,?,?)').bind(id(),e.id,e.status,'cancellation_requested',reason,u.id)]);await audit(env,u.id,'expense_cancellation_requested','expense',e.id);return json({id:requestId},{status:201});}
  const cancelDecision=path.match(/^\/cancellation-requests\/([^/]+)\/decision$/);if(cancelDecision&&request.method==='POST'){const u=await requireUser(request,env,'admin');const x=await body(request),requestRow=await env.DB.prepare('SELECT c.*,e.status expense_status FROM cancellation_requests c JOIN expenses e ON e.id=c.expense_id WHERE c.id=? AND c.status=\'pending\'').bind(cancelDecision[1]).first();if(!requestRow)return fail('الطلب غير متاح',409);const approved=x.action==='approve';if(!approved&&x.action!=='reject')return fail('الإجراء غير صالح');await env.DB.batch([env.DB.prepare('UPDATE cancellation_requests SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=?').bind(approved?'approved':'rejected',u.id,now(),String(x.note||'').slice(0,500)||null,requestRow.id),env.DB.prepare(`UPDATE expenses SET status=?,cancelled_at=${approved?'?':'cancelled_at'},cancelled_by=${approved?'?':'cancelled_by'} WHERE id=?`).bind(...(approved?['cancelled',now(),u.id,requestRow.expense_id]:[requestRow.expense_status,requestRow.expense_id])),env.DB.prepare('INSERT INTO expense_history (id,expense_id,from_status,to_status,note,actor_id) VALUES (?,?,?,?,?,?)').bind(id(),requestRow.expense_id,'cancellation_requested',approved?'cancelled':requestRow.expense_status,String(x.note||'').slice(0,500),u.id)]);await audit(env,u.id,approved?'expense_cancelled':'expense_cancellation_rejected','expense',requestRow.expense_id);return json({ok:true});}
  if(path==='/reports/expenses.csv'){await requireUser(request,env,'admin');return csvReport(env);}
  if(path==='/reports/data'){await requireUser(request,env,'admin');return json(await reportData(env));}
  if(path==='/reports/expenses.xlsx'){await requireUser(request,env,'admin');return xlsxReport(env);}
  return fail('Not found',404);
 } catch(e) { if(e instanceof Response)return e; console.error(e);return fail(e.message==='المبلغ غير صالح'?e.message:'حدث خطأ غير متوقع',500); } } };

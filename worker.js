// ============================================================
// Demo Builder — Cloudflare Worker
// Handles: /extract (Anthropic) and /build (Smartsheet API)
// ============================================================
// Set these in Cloudflare Workers > Settings > Variables:
//   ANTHROPIC_API_KEY  — your Anthropic key
//   SMARTSHEET_TOKEN   — your Smartsheet API token
// ============================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });
      }

      const url = new URL(request.url);

      if (request.method === 'POST' && url.pathname === '/extract') {
        return await handleExtract(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/build') {
        return await handleBuild(request, env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: 'Worker crash: ' + e.message }, 500);
    }
  }
};

// ─── /extract ────────────────────────────────────────────────
async function handleExtract(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured in Cloudflare Worker environment variables' }, 500);
  // TEMP DEBUG — remove after confirming key
  return json({ debug: true, key_length: env.ANTHROPIC_API_KEY.length, key_prefix: env.ANTHROPIC_API_KEY.substring(0,14), key_suffix: env.ANTHROPIC_API_KEY.slice(-4) }, 200);
  let body;
  try { body = await request.json(); } catch(e) { return json({ error: 'Invalid request body' }, 400); }
  const { transcript } = body;
  if (!transcript) return json({ error: 'No transcript provided' }, 400);

  const systemPrompt = `You are a sales intelligence assistant. Extract structured client information from call transcripts or meeting notes. Respond ONLY with a valid JSON object — no markdown, no preamble.

Required fields (use empty string "" if not found):
{
  "company": "company name",
  "industry": "industry vertical",
  "size": "employee count or revenue if mentioned",
  "contacts": "key people with titles, comma separated",
  "region": "location or region",
  "tools": "current tools and processes they use",
  "pain": "primary pain points, comma separated",
  "outcomes": "desired outcomes or success metrics",
  "features": "Smartsheet features or capabilities that resonated",
  "timeline": "decision timeline or urgency signals",
  "budget": "budget signals or constraints mentioned"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: transcript }],
    }),
  });

  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'Anthropic error' }, 500);

  try {
    const text = data.content[0].text.trim();
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return json(parsed);
  } catch {
    return json({ error: 'Failed to parse extracted fields' }, 500);
  }
}

// ─── /build ──────────────────────────────────────────────────
async function handleBuild(request, env) {
  if (!env.SMARTSHEET_TOKEN) return json({ error: 'SMARTSHEET_TOKEN not configured in Cloudflare Worker environment variables' }, 500);
  let body;
  try { body = await request.json(); } catch(e) { return json({ error: 'Invalid request body' }, 400); }
  const { fields, assets, profile } = body;
  const log = [];
  const results = [];

  const ss = new SmartsheetClient(env.SMARTSHEET_TOKEN);

  // Step 1: Create workspace
  log.push({ msg: `Creating workspace "${fields.company} Demo"...`, type: 'info' });
  let workspaceId;
  try {
    const ws = await ss.createWorkspace(truncateName(`${fields.company} Demo`));
    workspaceId = ws.id;
    log.push({ msg: `Workspace created (ID: ${workspaceId})`, type: 'ok' });
    results.push({
      name: `${fields.company} Demo (workspace)`,
      type: 'Workspace',
      url: `https://app.smartsheet.com/workspaces/${workspaceId}`
    });
  } catch (e) {
    log.push({ msg: `Failed to create workspace: ${e.message}`, type: 'err' });
    return json({ error: e.message, log }, 500);
  }

  // Step 2: Build each requested asset
  for (const asset of assets) {
    if (asset === 'Demo workspace') continue; // already done
    try {
      log.push({ msg: `Building: ${asset}...`, type: 'info' });
      const sheet = await buildAsset(ss, workspaceId, asset, fields, profile);
      log.push({ msg: `✓ ${asset} created`, type: 'ok' });
      results.push({
        name: asset,
        type: 'Sheet',
        url: `https://app.smartsheet.com/sheets/${sheet.id}`
      });
    } catch (e) {
      log.push({ msg: `✗ ${asset} failed: ${e.message}`, type: 'err' });
    }
  }

  return json({ log, results });
}

// ─── Name helpers — Smartsheet max 50 chars ─────────────────
function schemaName(company, label) {
  const sep = ' — ';
  const maxCo = 50 - sep.length - label.length;
  const co = maxCo > 3 ? company.substring(0, maxCo) : company.substring(0, 10);
  return `${co}${sep}${label}`;
}
function truncateName(name) {
  if (name.length <= 50) return name;
  const cut = name.substring(0, 50);
  const sp = cut.lastIndexOf(' ');
  return sp > 30 ? cut.substring(0, sp) : cut;
}

// ─── Asset builder ────────────────────────────────────────────
async function buildAsset(ss, workspaceId, assetName, fields, profile) {
  const company = fields.company || 'Client';
  const industry = fields.industry || profile || 'General';

  const schemas = {
    'Project tracker': {
      name: `${company} — Project Tracker`,
      columns: getProjectColumns(industry),
      rows: getProjectRows(fields, industry),
    },
    'Status dashboard': {
      name: `${company} — Status Dashboard`,
      columns: getDashboardColumns(),
      rows: getDashboardRows(fields),
    },
    'Resource tracker': {
      name: `${company} — Resource Tracker`,
      columns: [
        { title: 'Team Member', type: 'TEXT_NUMBER', primary: true },
        { title: 'Role', type: 'TEXT_NUMBER' },
        { title: 'Project', type: 'TEXT_NUMBER' },
        { title: 'Capacity (%)', type: 'TEXT_NUMBER' },
        { title: 'Week of', type: 'DATE' },
        { title: 'Status', type: 'PICKLIST', options: ['Available', 'At Capacity', 'Overallocated'] },
      ],
      rows: [
        ['Sarah Chen', 'Project Lead', `${company} Rollout`, '80', '', 'At Capacity'],
        ['James Park', 'Analyst', `${company} Rollout`, '50', '', 'Available'],
        ['Maria Lopez', 'Coordinator', 'Multiple', '100', '', 'Overallocated'],
      ]
    },
    'Risk / issues log': {
      name: `${company} — Risk & Issues Log`,
      columns: [
        { title: 'Issue', type: 'TEXT_NUMBER', primary: true },
        { title: 'Category', type: 'PICKLIST', options: ['Risk', 'Issue', 'Decision', 'Action'] },
        { title: 'Priority', type: 'PICKLIST', options: ['Critical', 'High', 'Medium', 'Low'] },
        { title: 'Owner', type: 'CONTACT_LIST' },
        { title: 'Status', type: 'PICKLIST', options: ['Open', 'In Progress', 'Resolved', 'Closed'] },
        { title: 'Due Date', type: 'DATE' },
        { title: 'Notes', type: 'TEXT_NUMBER' },
      ],
      rows: [
        ['Data migration from legacy system', 'Risk', 'High', '', 'Open', '', 'Need IT sign-off'],
        ['Stakeholder availability for training', 'Issue', 'Medium', '', 'In Progress', '', ''],
        ['Select implementation partner', 'Decision', 'Critical', '', 'Open', '', ''],
      ]
    },
    'Intake form': {
      name: `${company} — Request Intake`,
      columns: [
        { title: 'Request Name', type: 'TEXT_NUMBER', primary: true },
        { title: 'Submitted By', type: 'CONTACT_LIST' },
        { title: 'Request Type', type: 'PICKLIST', options: ['New Project', 'Change Request', 'Support', 'Other'] },
        { title: 'Priority', type: 'PICKLIST', options: ['Urgent', 'High', 'Normal', 'Low'] },
        { title: 'Description', type: 'TEXT_NUMBER' },
        { title: 'Date Submitted', type: 'DATE' },
        { title: 'Status', type: 'PICKLIST', options: ['New', 'Under Review', 'Approved', 'Rejected'] },
      ],
      rows: [
        ['Sample: Website Redesign', '', 'New Project', 'High', 'Full redesign of client portal', '', 'New'],
        ['Sample: Q3 Report Update', '', 'Change Request', 'Normal', 'Update dashboard metrics for Q3', '', 'Under Review'],
      ]
    },
    'Budget tracker': {
      name: `${company} — Budget Tracker`,
      columns: [
        { title: 'Line Item', type: 'TEXT_NUMBER', primary: true },
        { title: 'Category', type: 'PICKLIST', options: ['Personnel', 'Software', 'Services', 'Equipment', 'Other'] },
        { title: 'Budgeted ($)', type: 'TEXT_NUMBER' },
        { title: 'Actual ($)', type: 'TEXT_NUMBER' },
        { title: 'Variance ($)', type: 'TEXT_NUMBER' },
        { title: 'Status', type: 'PICKLIST', options: ['On Track', 'At Risk', 'Over Budget'] },
        { title: 'Notes', type: 'TEXT_NUMBER' },
      ],
      rows: [
        ['Implementation Services', 'Services', '45000', '38500', '6500', 'On Track', ''],
        ['Software Licenses (annual)', 'Software', '24000', '24000', '0', 'On Track', ''],
        ['Training & Onboarding', 'Services', '8000', '9200', '-1200', 'Over Budget', 'Added extra sessions'],
        ['Internal Staff Time', 'Personnel', '15000', '12000', '3000', 'On Track', ''],
      ]
    },
    'Timeline / Gantt': {
      name: `${company} — Project Timeline`,
      columns: [
        { title: 'Task', type: 'TEXT_NUMBER', primary: true },
        { title: 'Phase', type: 'PICKLIST', options: ['Discovery', 'Design', 'Build', 'Test', 'Launch', 'Handover'] },
        { title: 'Owner', type: 'CONTACT_LIST' },
        { title: 'Start Date', type: 'DATE' },
        { title: 'End Date', type: 'DATE' },
        { title: 'Duration (days)', type: 'TEXT_NUMBER' },
        { title: 'Status', type: 'PICKLIST', options: ['Not Started', 'In Progress', 'Complete', 'Blocked'] },
        { title: '% Complete', type: 'TEXT_NUMBER' },
      ],
      rows: [
        ['Kickoff & requirements gathering', 'Discovery', '', '', '', '5', 'Complete', '100'],
        ['Solution design & workspace setup', 'Design', '', '', '', '7', 'In Progress', '60'],
        ['Sheet & workflow configuration', 'Build', '', '', '', '10', 'Not Started', '0'],
        ['User acceptance testing', 'Test', '', '', '', '5', 'Not Started', '0'],
        ['Training sessions', 'Launch', '', '', '', '3', 'Not Started', '0'],
        ['Go-live & hypercare', 'Launch', '', '', '', '7', 'Not Started', '0'],
        ['Admin handover', 'Handover', '', '', '', '2', 'Not Started', '0'],
      ]
    },
  };

  const schema = schemas[assetName] || getIndustrySchema(assetName, company);
  if (!schema) throw new Error(`No schema defined for: ${assetName}`);

  return await ss.createSheetInWorkspace(workspaceId, schema.name, schema.columns, schema.rows);
}

function getProjectColumns(industry) {
  const base = [
    { title: 'Project / Task', type: 'TEXT_NUMBER', primary: true },
    { title: 'Owner', type: 'CONTACT_LIST' },
    { title: 'Status', type: 'PICKLIST', options: ['Not Started', 'In Progress', 'Blocked', 'Complete'] },
    { title: 'Priority', type: 'PICKLIST', options: ['Critical', 'High', 'Medium', 'Low'] },
    { title: 'Start Date', type: 'DATE' },
    { title: 'Due Date', type: 'DATE' },
    { title: '% Complete', type: 'TEXT_NUMBER' },
    { title: 'Notes', type: 'TEXT_NUMBER' },
  ];

  const extras = {
    'Construction': [{ title: 'Site / Location', type: 'TEXT_NUMBER' }, { title: 'Contractor', type: 'TEXT_NUMBER' }],
    'Agency': [{ title: 'Client', type: 'TEXT_NUMBER' }, { title: 'Budget Code', type: 'TEXT_NUMBER' }],
    'Manufacturing': [{ title: 'Line / Cell', type: 'TEXT_NUMBER' }, { title: 'Batch #', type: 'TEXT_NUMBER' }],
    'Tech': [{ title: 'Sprint', type: 'TEXT_NUMBER' }, { title: 'Epic', type: 'TEXT_NUMBER' }],
  };

  const match = Object.keys(extras).find(k => industry.toLowerCase().includes(k.toLowerCase()));
  return match ? [...base, ...extras[match]] : base;
}

function getProjectRows(fields, industry) {
  const pain = fields.pain || '';
  return [
    [`Initial ${industry} workflow audit`, '', 'Complete', 'High', '', '', '100', 'Baseline established'],
    ['Smartsheet workspace configuration', '', 'In Progress', 'Critical', '', '', '60', pain ? `Addressing: ${pain.split(',')[0]}` : ''],
    ['Stakeholder training — round 1', '', 'Not Started', 'High', '', '', '0', ''],
    ['Dashboard setup and testing', '', 'Not Started', 'High', '', '', '0', ''],
    ['Data migration from existing tools', '', 'Not Started', 'Medium', '', '', '0', fields.tools ? `From: ${fields.tools}` : ''],
    ['Go-live and hypercare period', '', 'Not Started', 'Critical', '', '', '0', ''],
  ];
}

function getDashboardColumns() {
  return [
    { title: 'Metric', type: 'TEXT_NUMBER', primary: true },
    { title: 'Current Value', type: 'TEXT_NUMBER' },
    { title: 'Target', type: 'TEXT_NUMBER' },
    { title: 'Status', type: 'PICKLIST', options: ['On Track', 'At Risk', 'Off Track'] },
    { title: 'Last Updated', type: 'DATE' },
    { title: 'Owner', type: 'CONTACT_LIST' },
    { title: 'Notes', type: 'TEXT_NUMBER' },
  ];
}

function getDashboardRows(fields) {
  return [
    ['Projects Active', '8', '12', 'On Track', '', '', ''],
    ['On-time Delivery Rate', '74%', '90%', 'At Risk', '', '', fields.pain ? fields.pain.split(',')[0] : ''],
    ['Open Issues', '14', '< 5', 'Off Track', '', '', 'Reviewing weekly'],
    ['Team Utilization', '82%', '85%', 'On Track', '', '', ''],
    ['Budget Variance', '-3%', '< 5%', 'On Track', '', '', ''],
  ];
}


// Industry schema lookup — keyed by asset name
function getIndustrySchema(assetName, company) {
  const s = INDUSTRY_SCHEMAS(company);
  return s[assetName] || null;
}

function INDUSTRY_SCHEMAS(company) { return {
  // Agency / Creative
  'Campaign tracker': { name:schemaName(company, 'Campaign Tracker'), columns:[{title:'Campaign',type:'TEXT_NUMBER',primary:true},{title:'Client',type:'TEXT_NUMBER'},{title:'Channel',type:'PICKLIST',options:['Social','Paid Search','Email','Display','OOH','TV/Radio','Influencer','Content','Other']},{title:'Status',type:'PICKLIST',options:['Briefing','In Production','In Review','Live','Complete','Paused']},{title:'Start Date',type:'DATE'},{title:'End Date',type:'DATE'},{title:'Budget ($)',type:'TEXT_NUMBER'},{title:'Spent ($)',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Q3 Brand Awareness Push',company,'Social','Live','','','25000','18200','','Running across IG + LinkedIn'],['Summer Email Series',company,'Email','In Production','','','5000','1200','','6-part drip sequence'],['Paid Search — Brand Terms',company,'Paid Search','Live','','','8000','6100','','Google + Bing']]},
  'Creative request log': { name:schemaName(company, 'Creative Request Log'), columns:[{title:'Request Name',type:'TEXT_NUMBER',primary:true},{title:'Requested By',type:'CONTACT_LIST'},{title:'Asset Type',type:'PICKLIST',options:['Social Post','Banner Ad','Video','Email','Print','Presentation','Copywriting','Photography','Other']},{title:'Priority',type:'PICKLIST',options:['Urgent','High','Normal','Low']},{title:'Brief Received',type:'DATE'},{title:'Due Date',type:'DATE'},{title:'Assigned To',type:'CONTACT_LIST'},{title:'Status',type:'PICKLIST',options:['Briefing','In Progress','In Review','Revisions','Approved','Delivered']},{title:'Revision #',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Homepage hero banner — Q4','','Banner Ad','High','','','','In Progress','1','1200x628 + mobile'],['LinkedIn carousel — product launch','','Social Post','Urgent','','','','In Review','2','Client feedback pending']]},
  'Client deliverables tracker': { name:schemaName(company, 'Client Deliverables'), columns:[{title:'Deliverable',type:'TEXT_NUMBER',primary:true},{title:'Client',type:'TEXT_NUMBER'},{title:'Type',type:'PICKLIST',options:['Report','Creative Asset','Strategy Doc','Presentation','Data File','Video','Other']},{title:'Due Date',type:'DATE'},{title:'Owner',type:'CONTACT_LIST'},{title:'Status',type:'PICKLIST',options:['Not Started','In Progress','Client Review','Approved','Delivered','Overdue']},{title:'Delivered Date',type:'DATE'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Monthly Performance Report — July',company,'Report','','','Delivered','','Sent via email'],['Q3 Strategy Presentation',company,'Presentation','','','Client Review','','Awaiting sign-off']]},
  'Retainer hours log': { name:schemaName(company, 'Retainer Hours Log'), columns:[{title:'Task / Activity',type:'TEXT_NUMBER',primary:true},{title:'Client',type:'TEXT_NUMBER'},{title:'Team Member',type:'CONTACT_LIST'},{title:'Date',type:'DATE'},{title:'Hours',type:'TEXT_NUMBER'},{title:'Category',type:'PICKLIST',options:['Strategy','Creative','Production','Account Mgmt','Reporting','Meetings','Other']},{title:'Billable',type:'PICKLIST',options:['Yes','No']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Weekly status call',company,'','','1','Meetings','Yes',''],['Campaign performance analysis',company,'','','3','Reporting','Yes',''],['Creative brief development',company,'','','2','Strategy','Yes',''],['Internal coordination',company,'','','1.5','Account Mgmt','No','Non-billable prep']]},
  'Media plan sheet': { name:schemaName(company, 'Media Plan'), columns:[{title:'Placement',type:'TEXT_NUMBER',primary:true},{title:'Channel',type:'PICKLIST',options:['Social','Paid Search','Display','Video','Audio','OOH','Print','TV','Other']},{title:'Platform / Vendor',type:'TEXT_NUMBER'},{title:'Format',type:'TEXT_NUMBER'},{title:'Start Date',type:'DATE'},{title:'End Date',type:'DATE'},{title:'Budget ($)',type:'TEXT_NUMBER'},{title:'CPM / CPC Target',type:'TEXT_NUMBER'},{title:'Impressions Target',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Planning','Booked','Live','Complete','Cancelled']}], rows:[['LinkedIn Sponsored Content','Social','LinkedIn','Single Image','','','12000','','500000','Live'],['Google Search — Brand','Paid Search','Google Ads','Text','','','8000','2.50','','Live'],['YouTube Pre-roll','Video','Google Ads','15s Pre-roll','','','6000','8.00','750000','Booked']]},
  // Construction
  'Site daily log': { name:schemaName(company, 'Site Daily Log'), columns:[{title:'Date',type:'DATE',primary:true},{title:'Site / Location',type:'TEXT_NUMBER'},{title:'Superintendent',type:'CONTACT_LIST'},{title:'Weather',type:'PICKLIST',options:['Clear','Cloudy','Rain','Snow','Wind','Extreme Heat']},{title:'Crew Count',type:'TEXT_NUMBER'},{title:'Work Completed',type:'TEXT_NUMBER'},{title:'Equipment On Site',type:'TEXT_NUMBER'},{title:'Visitors / Inspections',type:'TEXT_NUMBER'},{title:'Issues / Delays',type:'TEXT_NUMBER'},{title:'Safety Observations',type:'TEXT_NUMBER'}], rows:[['','Main Site','','Clear','24','Poured east foundation slab — 180m²','Excavator, concrete pump','Owner rep site visit','None','Pre-pour safety briefing completed']]},
  'Subcontractor tracker': { name:schemaName(company, 'Subcontractor Tracker'), columns:[{title:'Subcontractor',type:'TEXT_NUMBER',primary:true},{title:'Trade / Scope',type:'TEXT_NUMBER'},{title:'Contract Value ($)',type:'TEXT_NUMBER'},{title:'Start Date',type:'DATE'},{title:'Completion Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Not Mobilized','On Site','Complete','Deficiencies','Disputes']},{title:'Insurance Verified',type:'PICKLIST',options:['Yes','No','Expired']},{title:'Payment to Date ($)',type:'TEXT_NUMBER'},{title:'Holdback ($)',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['ABC Electrical','Electrical rough-in & fit-out','280000','','','On Site','Yes','140000','28000',''],['Plumb Right Inc.','Plumbing — all floors','195000','','','On Site','Yes','80000','19500','Waiting on fixtures']]},
  'RFI / submittal log': { name:schemaName(company, 'RFI & Submittal Log'), columns:[{title:'ID',type:'TEXT_NUMBER',primary:true},{title:'Type',type:'PICKLIST',options:['RFI','Submittal','Transmittal']},{title:'Subject',type:'TEXT_NUMBER'},{title:'Submitted By',type:'TEXT_NUMBER'},{title:'Submitted To',type:'TEXT_NUMBER'},{title:'Date Submitted',type:'DATE'},{title:'Response Due',type:'DATE'},{title:'Date Responded',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','Responded','Closed','Overdue']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['RFI-001','RFI','Anchor bolt layout clarification','GC Site Team','Engineer of Record','','','','Responded','See revised drawing A3.1'],['RFI-002','RFI','Concrete mix spec for exposed finish','GC Site Team','Architect','','','','Open','Response overdue']]},
  'Punch list': { name:schemaName(company, 'Punch List'), columns:[{title:'Item',type:'TEXT_NUMBER',primary:true},{title:'Location / Room',type:'TEXT_NUMBER'},{title:'Trade',type:'PICKLIST',options:['General','Electrical','Plumbing','HVAC','Finishes','Structural','Other']},{title:'Description',type:'TEXT_NUMBER'},{title:'Priority',type:'PICKLIST',options:['Critical','High','Normal']},{title:'Assigned To',type:'TEXT_NUMBER'},{title:'Due Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','In Progress','Complete','Verified']},{title:'Verified By',type:'CONTACT_LIST'}], rows:[['P-001','Suite 201','Finishes','Paint touch-up — north wall, 3 spots','Normal','ABC Painters','','Open',''],['P-002','Lobby','Electrical','Pot light trim missing — 2 fixtures','High','ABC Electrical','','In Progress','']]},
  'Safety incident log': { name:schemaName(company, 'Safety Incident Log'), columns:[{title:'Incident #',type:'TEXT_NUMBER',primary:true},{title:'Date',type:'DATE'},{title:'Site',type:'TEXT_NUMBER'},{title:'Type',type:'PICKLIST',options:['Near Miss','First Aid','Medical Aid','Lost Time','Property Damage','Environmental']},{title:'Description',type:'TEXT_NUMBER'},{title:'Persons Involved',type:'TEXT_NUMBER'},{title:'Reported By',type:'CONTACT_LIST'},{title:'Root Cause',type:'TEXT_NUMBER'},{title:'Corrective Action',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Open','Under Investigation','Closed']}], rows:[['INC-001','','Main Site','Near Miss','Unsecured load fell from scaffold','Crew on Level 3','','Inadequate tie-off procedure','Toolbox talk + revised protocol','Closed']]},
  'Material procurement log': { name:schemaName(company, 'Material Procurement Log'), columns:[{title:'Material / Item',type:'TEXT_NUMBER',primary:true},{title:'Spec / Model',type:'TEXT_NUMBER'},{title:'Supplier',type:'TEXT_NUMBER'},{title:'PO Number',type:'TEXT_NUMBER'},{title:'Qty Ordered',type:'TEXT_NUMBER'},{title:'Unit Cost ($)',type:'TEXT_NUMBER'},{title:'Total Cost ($)',type:'TEXT_NUMBER'},{title:'Order Date',type:'DATE'},{title:'Expected Delivery',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Not Ordered','On Order','Partially Delivered','Delivered','Delayed','Back-ordered']}], rows:[['Structural Steel — W-sections','A992 Grade 50','SteelPro','PO-1042','48 tonnes','1850','88800','','','Delivered'],['Elevator — 2-stop hydraulic','ThyssenKrupp TX-150','Elevator Co.','PO-1058','1 unit','85000','85000','','','On Order']]},
  // Enterprise
  'Executive portfolio view': { name:schemaName(company, 'Executive Portfolio'), columns:[{title:'Initiative',type:'TEXT_NUMBER',primary:true},{title:'Department',type:'TEXT_NUMBER'},{title:'Sponsor',type:'CONTACT_LIST'},{title:'Priority',type:'PICKLIST',options:['Strategic','High','Medium','Low']},{title:'Status',type:'PICKLIST',options:['On Track','At Risk','Off Track','Complete','On Hold']},{title:'Budget ($K)',type:'TEXT_NUMBER'},{title:'Spend to Date ($K)',type:'TEXT_NUMBER'},{title:'Target Date',type:'DATE'},{title:'Key Risks',type:'TEXT_NUMBER'},{title:'Last Updated',type:'DATE'}], rows:[['ERP System Modernization','IT','','Strategic','At Risk','2400','980','','Vendor delays',''],['Customer Portal Relaunch','Marketing','','High','On Track','450','210','','None',''],['Workforce Planning Initiative','HR','','Strategic','On Track','180','60','','Change management','']]},
  'Change management log': { name:schemaName(company, 'Change Management Log'), columns:[{title:'Change',type:'TEXT_NUMBER',primary:true},{title:'Type',type:'PICKLIST',options:['Process','Technology','Org Structure','Policy','Culture']},{title:'Impacted Groups',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Phase',type:'PICKLIST',options:['Awareness','Desire','Knowledge','Ability','Reinforcement']},{title:'Comms Sent',type:'PICKLIST',options:['Yes','No','Planned']},{title:'Training Required',type:'PICKLIST',options:['Yes','No']},{title:'Status',type:'PICKLIST',options:['Not Started','In Progress','Adopted','Stalled']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['New expense approval workflow','Process','Finance, All Managers','','Knowledge','Yes','Yes','In Progress','Training scheduled Week 3'],['Smartsheet rollout — Ops team','Technology','Operations dept','','Desire','Planned','Yes','Not Started','']]},
  'Meeting actions tracker': { name:schemaName(company, 'Meeting Actions Tracker'), columns:[{title:'Action Item',type:'TEXT_NUMBER',primary:true},{title:'Meeting / Source',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Due Date',type:'DATE'},{title:'Priority',type:'PICKLIST',options:['High','Medium','Low']},{title:'Status',type:'PICKLIST',options:['Open','In Progress','Complete','Deferred','Cancelled']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Finalize Q3 headcount plan','Leadership Weekly','','','High','In Progress','Draft due to HR by EOW'],['Share vendor shortlist with procurement','Ops Review','','','Medium','Open','']]},
  'Policy & compliance register': { name:schemaName(company, 'Policy & Compliance Register'), columns:[{title:'Policy / Requirement',type:'TEXT_NUMBER',primary:true},{title:'Category',type:'PICKLIST',options:['HR','IT Security','Financial','Health & Safety','Privacy','Regulatory','Environmental']},{title:'Owner',type:'CONTACT_LIST'},{title:'Last Review Date',type:'DATE'},{title:'Next Review Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Current','Under Review','Overdue','Retired']},{title:'Applies To',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Acceptable Use Policy','IT Security','','','','Current','All staff','Annual review'],['Privacy Policy — Customer Data','Privacy','','','','Under Review','Marketing, Sales, IT','PIPEDA alignment update']]},
  'Vendor management sheet': { name:schemaName(company, 'Vendor Management'), columns:[{title:'Vendor',type:'TEXT_NUMBER',primary:true},{title:'Category',type:'PICKLIST',options:['Software','Professional Services','Hardware','Facilities','Marketing','Other']},{title:'Primary Contact',type:'TEXT_NUMBER'},{title:'Contract Value ($)',type:'TEXT_NUMBER'},{title:'Contract Start',type:'DATE'},{title:'Contract End',type:'DATE'},{title:'Auto-Renewal',type:'PICKLIST',options:['Yes','No','Unknown']},{title:'Performance Rating',type:'PICKLIST',options:['Excellent','Good','Fair','Poor']},{title:'Status',type:'PICKLIST',options:['Active','Under Review','Renewal Pending','Terminated']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Salesforce','Software','','48000','','','Yes','Good','Active','Annual renewal'],['Deloitte Consulting','Professional Services','','225000','','','No','Excellent','Active','SOW expires Q4']]},
  // Manufacturing
  'Production schedule': { name:schemaName(company, 'Production Schedule'), columns:[{title:'Production Run',type:'TEXT_NUMBER',primary:true},{title:'Product / SKU',type:'TEXT_NUMBER'},{title:'Line / Cell',type:'TEXT_NUMBER'},{title:'Shift',type:'PICKLIST',options:['Day','Afternoon','Night']},{title:'Planned Date',type:'DATE'},{title:'Planned Qty',type:'TEXT_NUMBER'},{title:'Actual Qty',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Scheduled','In Progress','Complete','Delayed','Cancelled']},{title:'Downtime (mins)',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['RUN-2401','SKU-A100 — Widget Alpha','Line 1','Day','','500','487','Complete','25','Minor belt adjustment'],['RUN-2402','SKU-B220 — Widget Beta','Line 2','Day','','300','','In Progress','0','']]},
  'Work order tracker': { name:schemaName(company, 'Work Order Tracker'), columns:[{title:'WO Number',type:'TEXT_NUMBER',primary:true},{title:'Type',type:'PICKLIST',options:['Preventive','Corrective','Emergency','Project','Inspection']},{title:'Asset / Equipment',type:'TEXT_NUMBER'},{title:'Description',type:'TEXT_NUMBER'},{title:'Priority',type:'PICKLIST',options:['Emergency','High','Medium','Low']},{title:'Assigned To',type:'CONTACT_LIST'},{title:'Created Date',type:'DATE'},{title:'Due Date',type:'DATE'},{title:'Completed Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','In Progress','On Hold','Complete','Cancelled']},{title:'Est. Hours',type:'TEXT_NUMBER'},{title:'Actual Hours',type:'TEXT_NUMBER'}], rows:[['WO-1188','Preventive','CNC Mill #3','Monthly lubrication & calibration','Medium','','','','','Open','2',''],['WO-1189','Corrective','Conveyor B — Zone 4','Belt slipping — misalignment','High','','','','','In Progress','4','2']]},
  'Equipment maintenance log': { name:schemaName(company, 'Equipment Maintenance Log'), columns:[{title:'Equipment',type:'TEXT_NUMBER',primary:true},{title:'Asset ID',type:'TEXT_NUMBER'},{title:'Location',type:'TEXT_NUMBER'},{title:'Last Service Date',type:'DATE'},{title:'Next Service Due',type:'DATE'},{title:'Service Type',type:'PICKLIST',options:['Lubrication','Calibration','Inspection','Parts Replacement','Full Overhaul']},{title:'Status',type:'PICKLIST',options:['OK','Service Due','Overdue','Out of Service']},{title:'Technician',type:'CONTACT_LIST'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['CNC Mill #1','AST-001','Bay A','','','Calibration','OK','',''],['CNC Mill #3','AST-003','Bay A','','','Lubrication','Service Due','','WO-1188 raised']]},
  'Quality / NCR log': { name:schemaName(company, 'Quality / NCR Log'), columns:[{title:'NCR Number',type:'TEXT_NUMBER',primary:true},{title:'Date Raised',type:'DATE'},{title:'Product / SKU',type:'TEXT_NUMBER'},{title:'Defect Type',type:'PICKLIST',options:['Dimensional','Surface Finish','Functional','Labelling','Documentation','Other']},{title:'Qty Affected',type:'TEXT_NUMBER'},{title:'Raised By',type:'CONTACT_LIST'},{title:'Root Cause',type:'TEXT_NUMBER'},{title:'Disposition',type:'PICKLIST',options:['Rework','Scrap','Use As Is','Return to Supplier','Under Review']},{title:'Corrective Action',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Open','Under Investigation','Corrective Action Pending','Closed']}], rows:[['NCR-0412','','SKU-B220','Dimensional','24 units','','Worn tooling on Line 2','Rework','Tool replaced — re-inspect batch','Closed']]},
  'Supplier scorecard': { name:schemaName(company, 'Supplier Scorecard'), columns:[{title:'Supplier',type:'TEXT_NUMBER',primary:true},{title:'Category',type:'TEXT_NUMBER'},{title:'On-Time Delivery (%)',type:'TEXT_NUMBER'},{title:'Quality Pass Rate (%)',type:'TEXT_NUMBER'},{title:'Responsiveness',type:'PICKLIST',options:['Excellent','Good','Fair','Poor']},{title:'Open Issues',type:'TEXT_NUMBER'},{title:'Overall Rating',type:'PICKLIST',options:['Preferred','Approved','Conditional','Probation','Disqualified']},{title:'Last Review Date',type:'DATE'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Acme Components Ltd.','Raw materials','96','99.2','Excellent','0','Preferred','',''],['GlobalParts Co.','Fasteners','81','97.5','Fair','2','Conditional','','Delivery issues Q2']]},
  'Inventory tracker': { name:schemaName(company, 'Inventory Tracker'), columns:[{title:'Item / SKU',type:'TEXT_NUMBER',primary:true},{title:'Description',type:'TEXT_NUMBER'},{title:'Location',type:'TEXT_NUMBER'},{title:'Unit of Measure',type:'TEXT_NUMBER'},{title:'Stock On Hand',type:'TEXT_NUMBER'},{title:'Reorder Point',type:'TEXT_NUMBER'},{title:'Reorder Qty',type:'TEXT_NUMBER'},{title:'Unit Cost ($)',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['OK','Low Stock','Out of Stock','On Order','Discontinued']},{title:'Last Count Date',type:'DATE'}], rows:[['RM-2201','Steel rod 12mm — Grade 60','Warehouse A, Bay 3','kg','1850','500','2000','1.85','OK',''],['RM-3102','Bearing 6205-2RS','Parts Store','each','12','20','50','8.40','Low Stock',''],['FG-A100','Widget Alpha — finished','FG Warehouse','each','0','100','200','24.00','Out of Stock','']]},
  // Tech / SaaS
  'Sprint tracker': { name:schemaName(company, 'Sprint Tracker'), columns:[{title:'Story / Task',type:'TEXT_NUMBER',primary:true},{title:'Epic',type:'TEXT_NUMBER'},{title:'Sprint',type:'TEXT_NUMBER'},{title:'Type',type:'PICKLIST',options:['Feature','Bug','Tech Debt','Spike','Infrastructure']},{title:'Points',type:'TEXT_NUMBER'},{title:'Priority',type:'PICKLIST',options:['Critical','High','Medium','Low']},{title:'Assignee',type:'CONTACT_LIST'},{title:'Status',type:'PICKLIST',options:['Backlog','In Sprint','In Progress','In Review','Done','Blocked']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['User auth — SSO integration','Auth & Access','Sprint 14','Feature','8','Critical','','In Progress','OAuth 2.0'],['Fix pagination bug — reports view','Reporting','Sprint 14','Bug','3','High','','In Review','PR #441 open']]},
  'Product roadmap': { name:schemaName(company, 'Product Roadmap'), columns:[{title:'Feature / Initiative',type:'TEXT_NUMBER',primary:true},{title:'Theme / Pillar',type:'TEXT_NUMBER'},{title:'Quarter',type:'PICKLIST',options:['Q1','Q2','Q3','Q4','Backlog']},{title:'Priority',type:'PICKLIST',options:['Must Have','Should Have','Nice to Have']},{title:'Status',type:'PICKLIST',options:['Planned','In Discovery','In Development','Beta','Launched','Deferred']},{title:'Product Owner',type:'CONTACT_LIST'},{title:'Customer Impact',type:'PICKLIST',options:['High','Medium','Low']},{title:'Effort Estimate',type:'PICKLIST',options:['XS','S','M','L','XL']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['SSO / enterprise auth','Security & Compliance','Q3','Must Have','In Development','','High','L','Top enterprise request'],['CSV + API export','Data & Integrations','Q3','Should Have','Planned','','High','M','']]},
  'Bug / defect log': { name:schemaName(company, 'Bug & Defect Log'), columns:[{title:'Bug ID',type:'TEXT_NUMBER',primary:true},{title:'Title',type:'TEXT_NUMBER'},{title:'Severity',type:'PICKLIST',options:['Critical','High','Medium','Low']},{title:'Environment',type:'PICKLIST',options:['Production','Staging','Dev','QA']},{title:'Reported By',type:'CONTACT_LIST'},{title:'Assigned To',type:'CONTACT_LIST'},{title:'Date Reported',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','In Progress','In Review','Fixed','Closed','Wont Fix']},{title:'Sprint / Release',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['BUG-881','Login loop on SSO timeout','Critical','Production','','','','In Progress','Sprint 14','Hotfix branch created'],['BUG-882','Export CSV — special chars malformed','High','Production','','','','Open','Sprint 14','']]},
  'Release checklist': { name:schemaName(company, 'Release Checklist'), columns:[{title:'Task',type:'TEXT_NUMBER',primary:true},{title:'Release',type:'TEXT_NUMBER'},{title:'Category',type:'PICKLIST',options:['Pre-release','Deployment','Post-release','Rollback']},{title:'Owner',type:'CONTACT_LIST'},{title:'Status',type:'PICKLIST',options:['Not Started','In Progress','Complete','Blocked','N/A']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Code freeze confirmed','v2.4.0','Pre-release','','Complete',''],['All P0/P1 bugs resolved','v2.4.0','Pre-release','','In Progress','BUG-881 still open'],['Staging smoke test passed','v2.4.0','Pre-release','','Not Started',''],['Deployment to production','v2.4.0','Deployment','','Not Started',''],['Monitor error rates — 1hr post deploy','v2.4.0','Post-release','','Not Started','']]},
  'Customer onboarding tracker': { name:schemaName(company, 'Customer Onboarding'), columns:[{title:'Customer',type:'TEXT_NUMBER',primary:true},{title:'Plan / Tier',type:'PICKLIST',options:['Starter','Growth','Enterprise']},{title:'CSM',type:'CONTACT_LIST'},{title:'Start Date',type:'DATE'},{title:'Go-Live Target',type:'DATE'},{title:'Stage',type:'PICKLIST',options:['Kickoff','Setup','Training','Integration','Go-Live','Adopted']},{title:'Health',type:'PICKLIST',options:['Green','Yellow','Red']},{title:'Last Touch',type:'DATE'},{title:'Blockers',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Apex Manufacturing','Enterprise','','','','Training','Green','','None','User rollout next week'],['Bloom Retail Group','Growth','','','','Integration','Yellow','','API key issue','']]},
  'OKR tracker': { name:schemaName(company, 'OKR Tracker'), columns:[{title:'Objective / Key Result',type:'TEXT_NUMBER',primary:true},{title:'Type',type:'PICKLIST',options:['Objective','Key Result']},{title:'Owner',type:'CONTACT_LIST'},{title:'Quarter',type:'TEXT_NUMBER'},{title:'Target',type:'TEXT_NUMBER'},{title:'Current',type:'TEXT_NUMBER'},{title:'Progress (%)',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['On Track','At Risk','Off Track','Achieved']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Become #1 tool for ops teams','Objective','','Q3','','','','On Track',''],['Reach 500 enterprise accounts','Key Result','','Q3','500','387','77','On Track',''],['Achieve NPS > 50','Key Result','','Q3','50','44','88','At Risk','Latest survey dipped']]},
  // Nonprofit / Gov
  'Grant tracker': { name:schemaName(company, 'Grant Tracker'), columns:[{title:'Grant / Funder',type:'TEXT_NUMBER',primary:true},{title:'Funder Type',type:'PICKLIST',options:['Government','Foundation','Corporate','Individual','Other']},{title:'Amount ($)',type:'TEXT_NUMBER'},{title:'Application Deadline',type:'DATE'},{title:'Decision Date',type:'DATE'},{title:'Grant Period End',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Prospecting','Application In Progress','Submitted','Awarded','Declined','Reporting Due','Closed']},{title:'Program Area',type:'TEXT_NUMBER'},{title:'Reporting Requirements',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'}], rows:[['Ontario Trillium Foundation','Government','75000','','','','Awarded','Youth Programs','Mid-year + final report',''],['RBC Foundation','Corporate','25000','','','','Application In Progress','Digital Literacy','','']]},
  'Program outcomes log': { name:schemaName(company, 'Program Outcomes Log'), columns:[{title:'Program',type:'TEXT_NUMBER',primary:true},{title:'Participant / Beneficiary',type:'TEXT_NUMBER'},{title:'Service Date',type:'DATE'},{title:'Service Type',type:'TEXT_NUMBER'},{title:'Duration (hrs)',type:'TEXT_NUMBER'},{title:'Staff Lead',type:'CONTACT_LIST'},{title:'Outcome Achieved',type:'PICKLIST',options:['Yes','Partial','No','In Progress']},{title:'Outcome Notes',type:'TEXT_NUMBER'},{title:'Follow-up Required',type:'PICKLIST',options:['Yes','No']}], rows:[['Youth Digital Skills','Participant Group A','','Workshop','3','','Yes','All participants completed module 1','No'],['Employment Readiness','Client 2042','','1-on-1 Coaching','1','','In Progress','Resume drafted — interview prep next','Yes']]},
  'Volunteer management sheet': { name:schemaName(company, 'Volunteer Management'), columns:[{title:'Volunteer Name',type:'TEXT_NUMBER',primary:true},{title:'Email',type:'TEXT_NUMBER'},{title:'Phone',type:'TEXT_NUMBER'},{title:'Skills / Interests',type:'TEXT_NUMBER'},{title:'Availability',type:'PICKLIST',options:['Weekdays','Weekends','Both','Flexible']},{title:'Program / Role',type:'TEXT_NUMBER'},{title:'Hours Logged (YTD)',type:'TEXT_NUMBER'},{title:'Background Check',type:'PICKLIST',options:['Cleared','Pending','Not Required']},{title:'Status',type:'PICKLIST',options:['Active','Inactive','On Leave']}], rows:[['Sample Volunteer A','','','Teaching, Technology','Weekends','Digital Skills Program','24','Cleared','Active'],['Sample Volunteer B','','','Administration','Weekdays','Office Support','12','Cleared','Active']]},
  'Event planning tracker': { name:schemaName(company, 'Event Planning Tracker'), columns:[{title:'Task',type:'TEXT_NUMBER',primary:true},{title:'Event',type:'TEXT_NUMBER'},{title:'Category',type:'PICKLIST',options:['Venue','Catering','Marketing','Logistics','Speakers','Volunteers','Budget','AV / Tech']},{title:'Owner',type:'CONTACT_LIST'},{title:'Due Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Not Started','In Progress','Complete','Blocked']},{title:'Budget Allocated ($)',type:'TEXT_NUMBER'},{title:'Actual Cost ($)',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Confirm venue booking','Annual Gala','Venue','','','Complete','8000','8000','Metro Convention Centre confirmed'],['Catering — menu selection','Annual Gala','Catering','','','In Progress','12000','','3 quotes received']]},
  'Stakeholder engagement log': { name:schemaName(company, 'Stakeholder Engagement Log'), columns:[{title:'Stakeholder',type:'TEXT_NUMBER',primary:true},{title:'Organization',type:'TEXT_NUMBER'},{title:'Role / Relationship',type:'TEXT_NUMBER'},{title:'Engagement Type',type:'PICKLIST',options:['Meeting','Email','Phone Call','Event','Site Visit','Report Shared']},{title:'Date',type:'DATE'},{title:'Owner',type:'CONTACT_LIST'},{title:'Outcome / Summary',type:'TEXT_NUMBER'},{title:'Next Step',type:'TEXT_NUMBER'},{title:'Follow-up Date',type:'DATE'}], rows:[['Hon. Jane Smith','City of Toronto','Funder — Councillor','Meeting','','','Discussed program outcomes','Send impact report by month end',''],['Robert Lee','United Way','Partner Organization','Phone Call','','','Aligned on referral pathway','Draft MOU and share','']]},
  // Healthcare
  'Patient project tracker': { name:schemaName(company, 'Patient Project Tracker'), columns:[{title:'Project / Initiative',type:'TEXT_NUMBER',primary:true},{title:'Department',type:'TEXT_NUMBER'},{title:'Lead',type:'CONTACT_LIST'},{title:'Patient Population',type:'TEXT_NUMBER'},{title:'Start Date',type:'DATE'},{title:'Target Completion',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Planning','Active','On Hold','Complete','Cancelled']},{title:'Regulatory Approval',type:'PICKLIST',options:['Not Required','Pending','Approved','Denied']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Diabetes Care Pathway Redesign','Endocrinology','','Type 2 Diabetic patients','','','Active','Not Required','Pilot running in Clinic 3']]},
  'Compliance audit log': { name:schemaName(company, 'Compliance Audit Log'), columns:[{title:'Audit Item',type:'TEXT_NUMBER',primary:true},{title:'Standard / Regulation',type:'TEXT_NUMBER'},{title:'Department',type:'TEXT_NUMBER'},{title:'Audit Date',type:'DATE'},{title:'Finding',type:'PICKLIST',options:['Compliant','Minor Gap','Major Gap','Critical','N/A']},{title:'Owner',type:'CONTACT_LIST'},{title:'Remediation Action',type:'TEXT_NUMBER'},{title:'Due Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','In Progress','Resolved','Verified']}], rows:[['Hand hygiene compliance — ICU','IPAC Standards','ICU','','Minor Gap','','Refresher training + monthly audit','','In Progress'],['Medication labelling — Pharmacy','ISMP Guidelines','Pharmacy','','Compliant','','None required','','Verified']]},
  'Staff credentialing tracker': { name:schemaName(company, 'Staff Credentialing'), columns:[{title:'Staff Member',type:'TEXT_NUMBER',primary:true},{title:'Role',type:'TEXT_NUMBER'},{title:'Department',type:'TEXT_NUMBER'},{title:'License / Credential',type:'TEXT_NUMBER'},{title:'Issuing Body',type:'TEXT_NUMBER'},{title:'Issue Date',type:'DATE'},{title:'Expiry Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Current','Expiring Soon','Expired','Renewal In Progress']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Dr. A. Chen','Physician','Emergency','CPSO License','CPSO','','','Current',''],['RN Sarah Park','Registered Nurse','ICU','CNO Registration','CNO','','','Expiring Soon','Renewal package sent']]},
  'Capital equipment request log': { name:schemaName(company, 'Capital Equipment Requests'), columns:[{title:'Equipment Request',type:'TEXT_NUMBER',primary:true},{title:'Department',type:'TEXT_NUMBER'},{title:'Requested By',type:'CONTACT_LIST'},{title:'Clinical Justification',type:'TEXT_NUMBER'},{title:'Estimated Cost ($)',type:'TEXT_NUMBER'},{title:'Priority',type:'PICKLIST',options:['Critical','High','Medium','Low']},{title:'Budget Year',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Submitted','Under Review','Approved','Procurement','Delivered','Rejected']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Portable Ultrasound Unit x2','Emergency','','Current units >10yr old — frequent failure','85000','Critical','2025','Approved','Procurement underway']]},
  'Incident / event report log': { name:schemaName(company, 'Incident & Event Report Log'), columns:[{title:'Incident #',type:'TEXT_NUMBER',primary:true},{title:'Date / Time',type:'DATE'},{title:'Department / Unit',type:'TEXT_NUMBER'},{title:'Event Type',type:'PICKLIST',options:['Medication Error','Patient Fall','Near Miss','Adverse Event','Equipment Failure','Privacy Breach','Other']},{title:'Severity',type:'PICKLIST',options:['No Harm','Minor','Moderate','Severe','Sentinel']},{title:'Reported By',type:'CONTACT_LIST'},{title:'Description',type:'TEXT_NUMBER'},{title:'Immediate Action Taken',type:'TEXT_NUMBER'},{title:'Root Cause',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Open','Under Review','RCA In Progress','Closed']}], rows:[['INC-2024-0441','','4 North — Med-Surg','Patient Fall','Minor','','Patient found on floor','Fall protocol activated','Under Investigation','Open']]},
  // Financial Services
  'Deal pipeline tracker': { name:schemaName(company, 'Deal Pipeline'), columns:[{title:'Deal / Opportunity',type:'TEXT_NUMBER',primary:true},{title:'Client',type:'TEXT_NUMBER'},{title:'Deal Type',type:'PICKLIST',options:['New Business','Upsell','Renewal','Cross-sell']},{title:'Stage',type:'PICKLIST',options:['Prospect','Qualified','Proposal','Negotiation','Closed Won','Closed Lost']},{title:'Value ($)',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Expected Close',type:'DATE'},{title:'Probability (%)',type:'TEXT_NUMBER'},{title:'Last Activity',type:'DATE'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Pension Fund Advisory — Apex Capital','Apex Capital Partners','New Business','Proposal','480000','','','60','','RFP submitted'],['Portfolio Rebalancing Service','Meridian Family Office','Upsell','Negotiation','125000','','','80','','Final pricing review']]},
  'Client onboarding checklist': { name:schemaName(company, 'Client Onboarding Checklist'), columns:[{title:'Task',type:'TEXT_NUMBER',primary:true},{title:'Client',type:'TEXT_NUMBER'},{title:'Category',type:'PICKLIST',options:['KYC / AML','Documentation','Account Setup','Funding','Communication','Compliance']},{title:'Owner',type:'CONTACT_LIST'},{title:'Due Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Not Started','In Progress','Complete','Blocked','N/A']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['KYC documentation collected','','KYC / AML','','','Complete',''],['AML screening completed','','KYC / AML','','','Complete',''],['Account agreement signed','','Documentation','','','In Progress','Awaiting wet signature'],['Account opened in system','','Account Setup','','','Not Started','']]},
  'Regulatory change log': { name:schemaName(company, 'Regulatory Change Log'), columns:[{title:'Regulation / Change',type:'TEXT_NUMBER',primary:true},{title:'Regulator',type:'TEXT_NUMBER'},{title:'Effective Date',type:'DATE'},{title:'Impact Area',type:'PICKLIST',options:['Operations','Compliance','Product','Reporting','Technology','Legal']},{title:'Severity',type:'PICKLIST',options:['High','Medium','Low']},{title:'Owner',type:'CONTACT_LIST'},{title:'Action Required',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['Monitoring','Impact Assessment','Implementation','Complete']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['T+1 Settlement Rule','SEC / CIRO','','Operations','High','','Update trade settlement workflows','Implementation',''],['ESG Disclosure Requirements — IFRS S2','ISSB','','Reporting','High','','Develop climate disclosure framework','Impact Assessment','']]},
  'Audit preparation tracker': { name:schemaName(company, 'Audit Preparation'), columns:[{title:'Audit Item',type:'TEXT_NUMBER',primary:true},{title:'Audit Type',type:'TEXT_NUMBER'},{title:'Evidence Required',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Evidence Location',type:'TEXT_NUMBER'},{title:'Due to Auditor',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Not Started','Gathering Evidence','Under Review','Submitted','Accepted']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['AML transaction monitoring logs — Q2','Regulatory Exam','System reports, sampling methodology','','Compliance drive — Q2-AML folder','','Submitted',''],['Employee training completion records','Internal Audit','LMS exports — all mandatory training','','HR system','','Gathering Evidence','']]},
  'Portfolio review sheet': { name:schemaName(company, 'Portfolio Review Sheet'), columns:[{title:'Client / Portfolio',type:'TEXT_NUMBER',primary:true},{title:'Advisor',type:'CONTACT_LIST'},{title:'AUM ($)',type:'TEXT_NUMBER'},{title:'Last Review Date',type:'DATE'},{title:'Next Review Due',type:'DATE'},{title:'Review Type',type:'PICKLIST',options:['Annual','Semi-Annual','Quarterly','Ad Hoc']},{title:'Status',type:'PICKLIST',options:['Scheduled','In Progress','Complete','Overdue','Cancelled']},{title:'Key Actions',type:'TEXT_NUMBER'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Chen Family Trust','','4200000','','','Annual','Scheduled','Review asset allocation vs. IPS',''],['Meridian Family Office','','12500000','','','Quarterly','Overdue','Rebalancing discussion pending','Client travel delayed Q2 review']]},
  // Real Estate
  'Property pipeline': { name:schemaName(company, 'Property Pipeline'), columns:[{title:'Property',type:'TEXT_NUMBER',primary:true},{title:'Type',type:'PICKLIST',options:['Residential','Commercial','Industrial','Mixed Use','Land']},{title:'Address',type:'TEXT_NUMBER'},{title:'Stage',type:'PICKLIST',options:['Prospecting','Due Diligence','LOI','Under Contract','Closed','Passed']},{title:'Asking Price ($)',type:'TEXT_NUMBER'},{title:'Offer Price ($)',type:'TEXT_NUMBER'},{title:'Cap Rate (%)',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Target Close',type:'DATE'},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Midtown Office Tower — 420 Bay','Commercial','420 Bay St, Toronto','Due Diligence','48000000','44500000','5.2','','','Environmental Phase 2 ordered'],['Warehousing Portfolio — Brampton','Industrial','Brampton, ON','LOI','22000000','21000000','6.1','','','LOI executed — 30 day exclusivity']]},
  'Lease tracker': { name:schemaName(company, 'Lease Tracker'), columns:[{title:'Unit / Space',type:'TEXT_NUMBER',primary:true},{title:'Property',type:'TEXT_NUMBER'},{title:'Tenant',type:'TEXT_NUMBER'},{title:'Use Type',type:'PICKLIST',options:['Office','Retail','Industrial','Residential','Parking','Storage']},{title:'Area (sq ft)',type:'TEXT_NUMBER'},{title:'Monthly Rent ($)',type:'TEXT_NUMBER'},{title:'Lease Start',type:'DATE'},{title:'Lease End',type:'DATE'},{title:'Renewal Option',type:'PICKLIST',options:['Yes','No']},{title:'Status',type:'PICKLIST',options:['Occupied','Vacant','Renewal Pending','Termination Notice','Expired']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Suite 200','420 Bay St','Acme Consulting Inc.','Office','3200','22400','','','Yes','Occupied','2-yr renewal option'],['Unit 12 — Ground Floor','420 Bay St','Metro Coffee','Retail','850','8500','','','No','Renewal Pending','Lease expires 90 days']]},
  'Maintenance work order log': { name:schemaName(company, 'Maintenance Work Orders'), columns:[{title:'WO #',type:'TEXT_NUMBER',primary:true},{title:'Property',type:'TEXT_NUMBER'},{title:'Unit / Location',type:'TEXT_NUMBER'},{title:'Reported By',type:'TEXT_NUMBER'},{title:'Issue / Description',type:'TEXT_NUMBER'},{title:'Trade',type:'PICKLIST',options:['General','Electrical','Plumbing','HVAC','Cleaning','Landscaping','Elevator','Other']},{title:'Priority',type:'PICKLIST',options:['Emergency','Urgent','Routine','Planned']},{title:'Assigned To',type:'TEXT_NUMBER'},{title:'Date Reported',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','Scheduled','In Progress','Complete','On Hold']},{title:'Cost ($)',type:'TEXT_NUMBER'}], rows:[['WO-0882','420 Bay St','Suite 200 — Washroom','Tenant','Running toilet — constant leak','Plumbing','Urgent','City Plumbing','','In Progress',''],['WO-0883','Brampton Industrial','Bay 4','Property Mgr','Overhead door — spring failure','General','Emergency','Door Pro Inc.','','Complete','850']]},
  'Inspection log': { name:schemaName(company, 'Property Inspection Log'), columns:[{title:'Inspection',type:'TEXT_NUMBER',primary:true},{title:'Property',type:'TEXT_NUMBER'},{title:'Type',type:'PICKLIST',options:['Routine','Move-in','Move-out','Annual','Fire Safety','Insurance','Buyer Due Diligence']},{title:'Inspection Date',type:'DATE'},{title:'Inspector',type:'TEXT_NUMBER'},{title:'Overall Condition',type:'PICKLIST',options:['Excellent','Good','Fair','Poor']},{title:'Deficiencies Found',type:'TEXT_NUMBER'},{title:'Follow-up Required',type:'PICKLIST',options:['Yes','No']},{title:'Status',type:'PICKLIST',options:['Scheduled','Complete','Report Pending','Deficiencies Open']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Annual Inspection — 420 Bay St','420 Bay St','Annual','','Property Mgr','Good','Lobby lighting, HVAC filter overdue','Yes','Deficiencies Open','']]},
  'Tenant communication log': { name:schemaName(company, 'Tenant Communication Log'), columns:[{title:'Subject',type:'TEXT_NUMBER',primary:true},{title:'Property',type:'TEXT_NUMBER'},{title:'Tenant',type:'TEXT_NUMBER'},{title:'Unit',type:'TEXT_NUMBER'},{title:'Type',type:'PICKLIST',options:['Complaint','Maintenance Request','Lease Query','Noise Issue','Payment Issue','General Inquiry']},{title:'Date Received',type:'DATE'},{title:'Owner',type:'CONTACT_LIST'},{title:'Response Date',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Open','In Progress','Resolved','Escalated']},{title:'Resolution Notes',type:'TEXT_NUMBER'}], rows:[['Heating not working — cold unit','420 Bay St','Acme Consulting','Suite 200','Maintenance Request','','','','In Progress','WO-0885 raised'],['Neighbour noise — after hours','Brampton Industrial','Tenant B','Unit 8','Noise Issue','','','','Resolved','Spoke to both tenants']]},
  // Retail / eCommerce
  'Product launch tracker': { name:schemaName(company, 'Product Launch Tracker'), columns:[{title:'Product',type:'TEXT_NUMBER',primary:true},{title:'Category',type:'TEXT_NUMBER'},{title:'SKU',type:'TEXT_NUMBER'},{title:'Launch Date',type:'DATE'},{title:'Stage',type:'PICKLIST',options:['Concept','Sourcing','Sampling','Production','QC','Listing','Marketing','Live']},{title:'Owner',type:'CONTACT_LIST'},{title:'Retail Price ($)',type:'TEXT_NUMBER'},{title:'COGS ($)',type:'TEXT_NUMBER'},{title:'Status',type:'PICKLIST',options:['On Track','At Risk','Delayed','Cancelled','Live']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Eco Tote Bag — Summer Collection','Accessories','ACC-2201','','Production','','28.00','6.50','On Track','Factory sample approved'],['Wireless Charging Pad v2','Electronics','ELEC-0441','','QC','','49.99','14.00','At Risk','CE certification pending']]},
  'Merchandising calendar': { name:schemaName(company, 'Merchandising Calendar'), columns:[{title:'Campaign / Event',type:'TEXT_NUMBER',primary:true},{title:'Type',type:'PICKLIST',options:['Promotion','Product Feature','Seasonal','Clearance','Launch','Holiday']},{title:'Channel',type:'PICKLIST',options:['Online','In-Store','Both']},{title:'Start Date',type:'DATE'},{title:'End Date',type:'DATE'},{title:'Products Featured',type:'TEXT_NUMBER'},{title:'Discount / Offer',type:'TEXT_NUMBER'},{title:'Owner',type:'CONTACT_LIST'},{title:'Status',type:'PICKLIST',options:['Planning','Assets In Progress','Ready','Live','Complete']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Back to School — August','Seasonal','Both','','','Bags, stationery, tech accessories','15% off select items','','Planning',''],['Labour Day Weekend Sale','Promotion','Online','','','Sitewide','20% off + free shipping','','Assets In Progress','']]},
  'Supplier / PO tracker': { name:schemaName(company, 'Supplier & PO Tracker'), columns:[{title:'PO Number',type:'TEXT_NUMBER',primary:true},{title:'Supplier',type:'TEXT_NUMBER'},{title:'Product / SKU',type:'TEXT_NUMBER'},{title:'Qty Ordered',type:'TEXT_NUMBER'},{title:'Unit Cost ($)',type:'TEXT_NUMBER'},{title:'Total Value ($)',type:'TEXT_NUMBER'},{title:'Order Date',type:'DATE'},{title:'Expected Ship',type:'DATE'},{title:'Expected Arrival',type:'DATE'},{title:'QC Passed',type:'PICKLIST',options:['Yes','No','Pending','N/A']},{title:'Status',type:'PICKLIST',options:['Draft','Confirmed','In Production','Shipped','In Transit','Arrived','QC Hold','Closed']}], rows:[['PO-4421','EcoSource Factory','ACC-2201 Eco Tote (5,000 units)','5000','6.50','32500','','','','Pending','In Production'],['PO-4422','TechParts Ltd','ELEC-0441 Charging Pad (2,000 units)','2000','14.00','28000','','','','No','QC Hold']]},
  'Store ops checklist': { name:schemaName(company, 'Store Ops Checklist'), columns:[{title:'Task',type:'TEXT_NUMBER',primary:true},{title:'Location',type:'TEXT_NUMBER'},{title:'Frequency',type:'PICKLIST',options:['Daily','Weekly','Monthly','Opening','Closing']},{title:'Department',type:'PICKLIST',options:['Sales Floor','Stockroom','Cash','Fitting Room','Exterior','All']},{title:'Assigned To',type:'CONTACT_LIST'},{title:'Last Completed',type:'DATE'},{title:'Status',type:'PICKLIST',options:['Complete','Incomplete','In Progress','N/A']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['Cash reconciliation','All locations','Daily','Cash','','','Complete',''],['Floor walk — zone check','All locations','Opening','Sales Floor','','','Complete',''],['Window display update','Flagship — Queen St','Weekly','Sales Floor','','','Incomplete','Display team needed']]},
  'Returns & escalations log': { name:schemaName(company, 'Returns & Escalations Log'), columns:[{title:'Case #',type:'TEXT_NUMBER',primary:true},{title:'Date',type:'DATE'},{title:'Order #',type:'TEXT_NUMBER'},{title:'Customer',type:'TEXT_NUMBER'},{title:'Product / SKU',type:'TEXT_NUMBER'},{title:'Reason Code',type:'PICKLIST',options:['Defective','Wrong Item','Not As Described','Changed Mind','Sizing Issue','Damaged in Transit','Other']},{title:'Channel',type:'PICKLIST',options:['Online','In-Store','Phone','Email','Social Media']},{title:'Escalated',type:'PICKLIST',options:['Yes','No']},{title:'Resolution',type:'PICKLIST',options:['Refund','Exchange','Store Credit','Repair','Replacement','Denied','Pending']},{title:'Status',type:'PICKLIST',options:['Open','In Progress','Resolved','Closed']},{title:'Notes',type:'TEXT_NUMBER'}], rows:[['RTN-8821','','ORD-44201','Jane D.','ELEC-0441 Charging Pad','Defective','Online','No','Replacement','Resolved','Unit not charging — replacement shipped'],['RTN-8822','','ORD-44388','Marco R.','ACC-2201 Tote','Wrong Item','Online','No','Exchange','In Progress','Correct item being picked']]},
}; }

// ─── Smartsheet API client ────────────────────────────────────
class SmartsheetClient {
  constructor(token) {
    this.token = token;
    this.base = 'https://api.smartsheet.com/2.0';
  }

  async req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `Smartsheet API error ${res.status}`);
    return data;
  }

  async createWorkspace(name) {
    return this.req('POST', '/workspaces', { name });
  }

  async createSheetInWorkspace(workspaceId, name, columns, rows) {
    // Build primary column first (required by Smartsheet)
    const primary = columns.find(c => c.primary);
    const rest = columns.filter(c => !c.primary);
    const orderedCols = primary ? [primary, ...rest] : columns;

    const colDefs = orderedCols.map((c, i) => {
      const def = { title: c.title, type: c.type, primary: !!c.primary };
      if (c.options) def.options = c.options;
      return def;
    });

    const sheet = await this.req('POST', `/workspaces/${workspaceId}/sheets`, {
      name,
      columns: colDefs,
    });

    // Add sample rows if provided
    if (rows && rows.length && sheet.id) {
      const colIds = sheet.columns.map(c => c.id);
      const rowPayload = rows.map(row => ({
        cells: row.map((val, i) => ({
          columnId: colIds[i],
          value: val || '',
        })).filter((_, i) => i < colIds.length)
      }));

      try {
        await this.req('POST', `/sheets/${sheet.id}/rows`, rowPayload);
      } catch (e) {
        // Rows are nice-to-have; don't fail the whole build
        console.error('Row insert failed:', e.message);
      }
    }

    return sheet;
  }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

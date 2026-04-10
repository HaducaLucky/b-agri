// Helper to convert Base64 string to downloadable Blob URL
function triggerDownloadFromBase64(base64String, filename, mimeType = 'application/pdf') {
  try {
    const binaryString = atob(base64String);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Revoke object URL after use
    setTimeout(() => URL.revokeObjectURL(url), 100);
  } catch (err) {
    console.error('Download failed:', err);
    alert('Could not download file.');
  }
}

// Initialize IndexedDB
const DB_NAME = 'FarmersDB';
const DB_VERSION = 5;
const STORE_NAME = 'farmers';

let db;
let currentQRCode = null;

// Get current user from session
function getCurrentUser() {
  const userStr = localStorage.getItem('currentUser');
  return userStr ? JSON.parse(userStr) : null;
}

// Log audit trail entry
function logAudit(action, details) {
  const user = getCurrentUser();
  if (!db) return;

  const entry = {
    timestamp: new Date().toISOString(),
    action,
    user: user ? `${user.username} (${user.role})` : 'Unknown',
    details
  };

  try {
    const transaction = db.transaction(['audit'], 'readwrite');
    const store = transaction.objectStore('audit');
    store.add(entry);
  } catch (err) {
    console.error('Failed to log audit:', err);
  }
}

// Check if QRCode is loaded
if (typeof QRCode === 'undefined') {
  console.error('QRCode library not loaded. Please include qrcode.min.js');
  alert('Error: QR Code library not found.');
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      db = event.target.result;

      // Farmers Store
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('farmerID', 'farmerID', { unique: true });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('registeredBarangay', 'registeredBarangay', { unique: false });
      }

      // Audit Trail Store
      if (!db.objectStoreNames.contains('audit')) {
        const auditStore = db.createObjectStore('audit', { keyPath: 'timestamp', autoIncrement: false });
        auditStore.createIndex('action', 'action', { unique: false });
        auditStore.createIndex('user', 'user', { unique: false });
      }

      // Users Store
      if (!db.objectStoreNames.contains('users')) {
        const userStore = db.createObjectStore('users', { keyPath: 'id', autoIncrement: false });
        userStore.createIndex('username', 'username', { unique: true });
        userStore.createIndex('role', 'role', { unique: false });
      }
    };
  });
}

// Convert File to Base64 Object
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (!file.type || !file.type.startsWith('application/pdf')) {
      alert(`⚠️ Only PDF files allowed. Skipping ${file.name}`);
      return resolve(null);
    }
    if (file.size > 10 * 1024 * 1024) {
      alert(`⚠️ File too large: ${file.name}. Max 10 MB.`);
      return resolve(null);
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64String = reader.result.split(',')[1];
      resolve({
        name: file.name,
        size: file.size,
        type: file.type,
        base64: base64String
      });
    };
    reader.onerror = () => reject('Failed to read file');
    reader.readAsDataURL(file);
  });
}

// Generate truly unique QR code data for internal use
function generateUniqueQRData(farmerID, farmerName) {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 5);
  return `${farmerID}||${farmerName}||${timestamp}||${random}`;
}

// Generate Farmer ID: BANAYOYO-{BARANGAY}-0001
async function generateFarmerID(selectedBarangay) {
  if (!db) return 'BANAYOYO-ERROR-0001';
  if (!selectedBarangay) return 'BANAYOYO-SELECT-0001';

  const normalizedBarangay = selectedBarangay.toUpperCase().replace(/\s+/g, '');
  const prefix = `BANAYOYO-${normalizedBarangay}-`;

  let maxNum = 0;

  try {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('farmerID');
    const request = index.openCursor();

    return new Promise((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const id = cursor.key;
          if (typeof id === 'string' && id.startsWith(prefix)) {
            const numStr = id.slice(prefix.length);
            const num = parseInt(numStr, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
          cursor.continue();
        } else {
          const nextNum = maxNum + 1;
          const id = `${prefix}${nextNum.toString().padStart(4, '0')}`;
          resolve(id);
        }
      };
      request.onerror = () => resolve(`${prefix}0001`);
    });
  } catch (err) {
    console.error('Error generating Farmer ID:', err);
    return `BANAYOYO-${normalizedBarangay || 'ERR'}-0001`;
  }
}

// Load unique crop/livestock types from all farmers
async function loadCropOptions() {
  const cropsSet = new Set();
  try {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const farmers = request.result;
        farmers.forEach(farmer => {
          if (farmer.farmRecords && Array.isArray(farmer.farmRecords)) {
            farmer.farmRecords.forEach(r => {
              if (r.cropType && r.cropType.trim()) {
                cropsSet.add(r.cropType.trim());
              }
            });
          }
        });

        const cropSelect = document.getElementById('filterCrop');
        cropSelect.innerHTML = '<option value="">All</option>';
        Array.from(cropsSet)
          .sort()
          .forEach(crop => {
            const option = document.createElement('option');
            option.value = crop;
            option.textContent = crop;
            cropSelect.appendChild(option);
          });

        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Error loading crop options:', err);
  }
}

// Render farmer list with filters
async function renderFarmers(filters = {}) {
  const farmers = await loadFarmers();
  const tbody = document.querySelector('#farmerTable tbody');
  tbody.innerHTML = '';

  const filtered = farmers.filter(farmer => {
    const matchesSearch = !filters.search ||
      farmer.name.toLowerCase().includes(filters.search);

    const matchesMainBarangay = !filters.barangay ||
      farmer.registeredBarangay === filters.barangay;

    const hasMatchingRecord = (farmer.farmRecords || []).some(r => {
      const matchesCrop = !filters.crop || r.cropType === filters.crop;
      const matchesSeason = !filters.season || r.seasonType === filters.season;
      const regDate = r.registrationDate;
      const afterStart = !filters.dateFrom || !regDate || regDate >= filters.dateFrom;
      const beforeEnd = !filters.dateTo || !regDate || regDate <= filters.dateTo;
      return matchesCrop && matchesSeason && afterStart && beforeEnd;
    });

    return matchesSearch && matchesMainBarangay && hasMatchingRecord;
  });

  const currentUser = getCurrentUser();
  const canEdit = currentUser && ['Administrator', 'Encoder'].includes(currentUser.role);

  filtered.forEach(farmer => {
    const totalSize = farmer.farmRecords
      ? farmer.farmRecords.reduce((sum, r) => sum + parseFloat(r.farmSize || 0), 0).toFixed(2)
      : '0.00';

    const crops = farmer.farmRecords ? [...new Set(farmer.farmRecords.map(r => r.cropType))].join(', ') : '';
    const seasons = farmer.farmRecords ? [...new Set(farmer.farmRecords.map(r => r.seasonType))].join(', ') : '';
    const dates = farmer.farmRecords ? [...new Set(farmer.farmRecords.map(r => r.registrationDate))].join(', ') : '';

    const tr = document.createElement('tr');

    let actionButtons = `<button class="view" data-id="${farmer.id}">View</button>`;
    if (canEdit) {
      actionButtons += `
        <button class="edit" data-id="${farmer.id}">Edit</button>
        <button class="delete" data-id="${farmer.id}">Delete</button>
      `;
    }

    tr.innerHTML = `
      <td>${farmer.name}</td>
      <td>${farmer.registeredBarangay || 'N/A'}</td>
      <td>${totalSize}</td>
      <td>${crops || 'N/A'}</td>
      <td>${seasons || 'N/A'}</td>
      <td>${dates || 'N/A'}</td>
      <td class="actions">${actionButtons}</td>
    `;
    tbody.appendChild(tr);
  });

  attachRowListeners();
}

// Attach View/Edit/Delete listeners
function attachRowListeners() {
  document.querySelectorAll('.view').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.dataset.id);
      const farmers = await loadFarmers();
      const farmer = farmers.find(f => f.id === id);
      if (farmer) openViewModal(farmer);
    });
  });

  document.querySelectorAll('.edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = Number(e.target.dataset.id);
      const farmers = await loadFarmers();
      const farmer = farmers.find(f => f.id === id);
      if (farmer) openModal('Edit Farmer', farmer);
    });
  });

  document.querySelectorAll('.delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (confirm('Delete this farmer?')) {
        const id = Number(e.target.dataset.id);
        await deleteFarmer(id);
        logAudit('DELETE_FARMER', `Deleted Farmer ID: ${id}`);
        applyFilters();
        setTimeout(() => loadCropOptions(), 500);
      }
    });
  });
}

// Open View Modal
function openViewModal(farmer) {
  const viewModal = document.getElementById('viewModal');
  const viewContent = document.getElementById('viewContent');

  viewModal.style.display = 'block';
  viewContent.innerHTML = '';

  function addField(label, value, isHtml = false) {
    const div = document.createElement('div');
    div.className = 'view-field';
    div.innerHTML = `<label>${label}:</label><div class="value">${isHtml ? value : (value || 'N/A')}</div>`;
    viewContent.appendChild(div);
  }

  addField('Farmer ID', farmer.farmerID);
  addField('Full Name', farmer.name);
  addField('Registered Barangay', farmer.registeredBarangay);
  addField('Age', farmer.age);
  addField('Sex', farmer.sex);
  addField('Cedula Number', farmer.cedulaNumber);

  // QR Code
  const qrDiv = document.createElement('div');
  qrDiv.className = 'view-field';
  qrDiv.innerHTML = '<label>QR Code:</label><div class="value"></div>';
  viewContent.appendChild(qrDiv);
  new QRCode(qrDiv.querySelector('.value'), {
    text: farmer.qrCodeData || farmer.farmerID,
    width: 100,
    height: 100
  });

  // Farm Records Table
  if (farmer.farmRecords && farmer.farmRecords.length > 0) {
    const recordsDiv = document.createElement('div');
    recordsDiv.className = 'view-field view-farm-records';
    recordsDiv.innerHTML = '<label>Farm Records:</label>';

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Barangay</th>
          <th>Farm Size (ha) / Head(s)</th>
          <th>Crop/Livestock</th>
          <th>Season</th>
          <th>Date</th>
          <th>Tax Clearance</th>
          <th>RSBA Form</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');

    farmer.farmRecords.forEach(r => {
      let sizeText = 'N/A';
      const hasSize = r.farmSize !== undefined && r.farmSize !== '' && !isNaN(parseFloat(r.farmSize));
      const hasHeads = r.noOfHeads !== undefined && r.noOfHeads !== '' && !isNaN(parseInt(r.noOfHeads));

      if (hasSize && hasHeads) {
        sizeText = `${parseFloat(r.farmSize).toFixed(2)} / ${parseInt(r.noOfHeads)}`;
      } else if (hasSize) {
        sizeText = parseFloat(r.farmSize).toFixed(2);
      } else if (hasHeads) {
        sizeText = parseInt(r.noOfHeads);
      }

      const taxLink = r.taxClearance && r.taxClearance.base64
        ? `<button type="button" class="download-file-btn"
            onclick="triggerDownloadFromBase64('${r.taxClearance.base64}', '${r.taxClearance.name}')">
            💾 Download PDF
          </button>`
        : 'No file';

      const rsbaLink = r.rsbaForm && r.rsbaForm.base64
        ? `<button type="button" class="download-file-btn"
            onclick="triggerDownloadFromBase64('${r.rsbaForm.base64}', '${r.rsbaForm.name}')">
            💾 Download PDF
          </button>`
        : 'No file';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.barangay}</td>
        <td>${sizeText}</td>
        <td>${r.cropType || 'N/A'}</td>
        <td>${r.seasonType || 'N/A'}</td>
        <td>${r.registrationDate || 'N/A'}</td>
        <td>${taxLink}</td>
        <td>${rsbaLink}</td>
      `;
      tbody.appendChild(tr);
    });

    recordsDiv.appendChild(table);
    viewContent.appendChild(recordsDiv);
  }

  // Print Slip button
  document.getElementById('printSlipBtn').onclick = () => {
    printRegistrationSlip(farmer);
  };

  // Close handled globally below
}

// Print Registration Slip
function printRegistrationSlip(farmer) {
  const tempDiv = document.createElement('div');
  const qrText = farmer.qrCodeData || farmer.farmerID;

  new QRCode(tempDiv, {
    text: qrText,
    width: 100,
    height: 100,
    correctLevel: QRCode.CorrectLevel.H
  });

  let qrImageSrc = '';
  const canvas = tempDiv.querySelector('canvas');
  if (canvas) {
    try {
      qrImageSrc = canvas.toDataURL('image/png');
    } catch (err) {
      qrImageSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=' + encodeURIComponent(qrText);
    }
  } else {
    qrImageSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=' + encodeURIComponent(qrText);
  }

  tempDiv.innerHTML = '';

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let recordsHtml = '';
  if (farmer.farmRecords && farmer.farmRecords.length > 0) {
    farmer.farmRecords.forEach(r => {
      let sizeText = 'N/A';
      const hasSize = r.farmSize !== undefined && r.farmSize !== '' && !isNaN(parseFloat(r.farmSize));
      const hasHeads = r.noOfHeads !== undefined && r.noOfHeads !== '' && !isNaN(parseInt(r.noOfHeads));

      if (hasSize && hasHeads) {
        sizeText = `${parseFloat(r.farmSize).toFixed(2)} / ${parseInt(r.noOfHeads)}`;
      } else if (hasSize) {
        sizeText = parseFloat(r.farmSize).toFixed(2);
      } else if (hasHeads) {
        sizeText = parseInt(r.noOfHeads);
      }

      recordsHtml += `
        <tr>
          <td>${r.barangay || 'N/A'}</td>
          <td>${sizeText}</td>
          <td>${r.cropType || 'N/A'}</td>
          <td>${r.seasonType || 'N/A'}</td>
          <td>${r.registrationDate || 'N/A'}</td>
        </tr>
      `;
    });
  } else {
    recordsHtml = `
      <tr>
        <td colspan="5" style="text-align:center; font-style:italic;">No farm records</td>
      </tr>
    `;
  }

  const css = `
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 10px; color: #333; }
      .header-section { text-align: center; margin-bottom: 5px; }
      .logo-row { display: flex; justify-content: center; align-items: center; gap: 15px; margin: 0; padding: 0; }
      .logo-row img { width: 64px; height: 64px; object-fit: contain; margin: 0; }
      .title-text { margin: 2px 0; padding: 0; line-height: 1.2; font-size: 15px; font-weight: bold; text-align: center; }
      hr { border: 1px solid #2e7d32; margin: 8px 0; }
      .slip-container { max-width: 900px; margin: 0 auto; border: 1px solid #ccc; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
      .slip { width: 100%; padding: 15px; box-sizing: border-box; }
      .slip-copy { font-weight: bold; font-size: 18px; text-align: center; margin-bottom: 10px; }
      .info-table { width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 16px; }
      .info-table td { padding: 6px 0; text-align: center; vertical-align: middle; }
      .info-table td:first-child { font-weight: bold; color: #2e7d32; }
      .qrcode { width: 100px; height: 100px; margin: 0 auto; border: none; }
      h3 { margin: 10px 0; color: #2e7d32; font-size: 16px; text-align: center; border-bottom: 1px dashed #aaa; padding-bottom: 2px; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { padding: 6px; text-align: center; border: 1px solid #aaa; font-size: 13px; }
      th { background-color: #f0f7f0; color: #2e7d32; font-weight: bold; }
      .cut-line { height: 2px; background: linear-gradient(to right, transparent, red, transparent); border-top: 1px dashed #999; margin: 8px 0; position: relative; }
      .cut-line::after { content: "CUT HERE"; position: absolute; top: -8px; left: 50%; transform: translateX(-50%); background: white; padding: 0 10px; color: #d32f2f; font-size: 12px; font-weight: bold; }
      @media print { body { padding: 5px; } .no-print { display: none; } }
    </style>
  `;

  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>Registration Slip</title>${css}</head>
      <body>
        <div class="header-section">
          <div class="logo-row">
            <img src="banayoyo.png" alt="Logo"/><img src="binnuyog.png" alt="Logo"/>
          </div>
          <div class="title-text">Republic of the Philippines</div>
          <div class="title-text">Province of Ilocos Sur</div>
          <div class="title-text">MUNICIPALITY OF BANAYOYO</div>
          <div class="title-text"><strong>MUNICIPAL AGRICULTURE OFFICE</strong></div>
        </div>
        <hr />
        <div class="slip-container">
          <!-- OWNER'S COPY -->
          <div class="slip">
            <div class="slip-copy">OWNER'S COPY</div>
            <table class="info-table">
              <tr><td>Name:</td><td>${farmer.name}</td><td rowspan="3"><img src="${qrImageSrc}" class="qrcode"/></td></tr>
              <tr><td>Age:</td><td>${farmer.age || 'N/A'}</td></tr>
              <tr><td>Sex:</td><td>${farmer.sex || 'N/A'}</td></tr>
              <tr>
                <td>Reg. Barangay:</td>
                <td>${farmer.registeredBarangay || 'N/A'}</td>
                <td>Farmer ID:<br><strong>${farmer.farmerID || 'N/A'}</strong></td>
              </tr>
            </table>
            <h3>Farm Records</h3>
            <table>
              <thead><tr><th>Barangay</th><th>Farm Size (ha) / Head(s)</th><th>Crop</th><th>Season</th><th>Date Reg.</th></tr></thead>
              <tbody>${recordsHtml}</tbody>
            </table>
          </div>

          <div class="cut-line"></div>

          <!-- OFFICE COPY -->
          <div class="slip">
            <div class="slip-copy">OFFICE COPY</div>
            <table class="info-table">
              <tr><td>Name:</td><td>${farmer.name}</td><td rowspan="3"><img src="${qrImageSrc}" class="qrcode"/></td></tr>
              <tr><td>Age:</td><td>${farmer.age || 'N/A'}</td></tr>
              <tr><td>Sex:</td><td>${farmer.sex || 'N/A'}</td></tr>
              <tr>
                <td>Reg. Barangay:</td>
                <td>${farmer.registeredBarangay || 'N/A'}</td>
                <td>Farmer ID:<br><strong>${farmer.farmerID || 'N/A'}</strong></td>
              </tr>
            </table>
            <h3>Farm Records</h3>
            <table>
              <thead><tr><th>Barangay</th><th>Farm Size (ha) / Head(s)</th><th>Crop</th><th>Season</th><th>Date Reg.</th></tr></thead>
              <tbody>${recordsHtml}</tbody>
            </table>
            <div style="margin-top:15px;"><strong>Issued On:</strong> ${today} | <strong>Prepared by:</strong> _________________________</div>
          </div>
        </div>
      </body>
    </html>
  `;

  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

// Print Summary Report
async function printReport(filters = {}) {
  const filteredFarmers = await getFilteredFarmers(filters);

  const win = window.open('', '_blank');
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  let tableRows = '';
  if (filteredFarmers.length === 0) {
    tableRows = `<tr><td colspan="6" style="text-align:center;padding:40px;color:#777;">No farmers match criteria.</td></tr>`;
  } else {
    filteredFarmers.forEach(farmer => {
      const size = farmer.farmRecords?.reduce((s, r) => s + parseFloat(r.farmSize || 0), 0).toFixed(2) || '0.00';
      const crops = [...new Set(farmer.farmRecords?.map(r => r.cropType) || [])].join(', ');
      const seasons = [...new Set(farmer.farmRecords?.map(r => r.seasonType) || [])].join(', ');
      const dates = [...new Set(farmer.farmRecords?.map(r => r.registrationDate) || [])].join(', ');

      tableRows += `
        <tr>
          <td>${farmer.name}</td>
          <td>${farmer.registeredBarangay || 'N/A'}</td>
          <td>${size}</td>
          <td>${crops}</td>
          <td>${seasons}</td>
          <td>${dates}</td>
        </tr>`;
    });
  }

  const filterParts = [];
  if (filters.search) filterParts.push(`Name contains "${filters.search}"`);
  if (filters.barangay) filterParts.push(`Barangay: ${filters.barangay}`);
  if (filters.crop) filterParts.push(`Crop: ${filters.crop}`);
  if (filters.season) filterParts.push(`Season: ${filters.season}`);
  if (filters.dateFrom) filterParts.push(`From: ${new Date(filters.dateFrom).toLocaleDateString()}`);
  if (filters.dateTo) filterParts.push(`To: ${new Date(filters.dateTo).toLocaleDateString()}`);

  const filterText = filterParts.length ? filterParts.join(', ') : 'All records';

  const html = `
    <html><head><title>Summary Report</title>
    <style>
      body { font-family: Arial; margin: 20px; color: #333; }
      .header-section { text-align: center; margin-bottom: 20px; }
      .logo-row { display: flex; justify-content: center; gap: 20px; align-items: center; margin-bottom: 5px; }
      .logo-row img { width: 72px; height: 72px; object-fit: contain; }
      .title-text { font-size: 16px; margin: 4px 0; }
      hr { border: 1px solid #2e7d32; margin: 15px 0; }
      h1 { text-align: center; color: #2e7d32; }
      .report-meta { display: flex; justify-content: space-between; font-size: 14px; color: #555; margin-bottom: 15px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; box-shadow: 0 0 8px rgba(0,0,0,0.1); }
      th, td { padding: 10px; text-align: left; border: 1px solid #aaa; font-size: 13px; }
      th { background-color: #e8f5e9; color: #2e7d32; font-weight: 600; }
      footer { margin-top: 40px; text-align: right; font-size: 12px; color: #777; }
      @media print { body { padding: 10px; } .no-print { display: none; } }
    </style>
    </head><body>
      <div class="header-section">
        <div class="logo-row">
          <img src="banayoyo.png" alt="Logo"/><img src="binnuyog.png" alt="Logo"/>
        </div>
        <div class="title-text">Republic of the Philippines</div>
        <div class="title-text">Province of Ilocos Sur</div>
        <div class="title-text">MUNICIPALITY OF BANAYOYO</div>
        <div class="title-text"><strong>MUNICIPAL AGRICULTURE OFFICE</strong></div>
      </div>
      <hr/>
      <h1>LOCAL FARMERS SUMMARY REPORT</h1>
      <div class="report-meta">
        <div><strong>Filters:</strong> ${filterText}</div>
        <div><strong>Date Generated:</strong> ${today}</div>
        <div><strong>Total:</strong> ${filteredFarmers.length}</div>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Barangay</th><th>Size/Heads</th><th>Crop</th><th>Season</th><th>Date</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      <footer class="no-print">Generated using Local Farmers Registration System</footer>
    </body></html>
  `;

  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 500);

  logAudit('PRINT_REPORT', `Generated report with filters: ${JSON.stringify(filters)}`);
}

// Open Add/Edit Modal
async function openModal(title, farmer = null) {
  try {
    if (!db) await openDB();
  } catch (err) {
    console.error('Failed to open DB:', err);
    alert('Database error. Please refresh.');
    return;
  }

  document.getElementById('modalTitle').textContent = title;
  document.getElementById('farmerModal').style.display = 'block';
  document.getElementById('farmerForm').reset();
  document.getElementById('farmerId').value = '';
  document.getElementById('farmRecordsBody').innerHTML = '';
  document.getElementById('qrcode').innerHTML = '';

  if (farmer) {
    document.getElementById('farmerId').value = farmer.id;
    document.getElementById('farmerID').value = farmer.farmerID;
    document.getElementById('name').value = farmer.name;
    document.getElementById('registeredBarangay').value = farmer.registeredBarangay || '';
    document.getElementById('age').value = farmer.age;
    document.getElementById('sex').value = farmer.sex || '';
    document.getElementById('cedulaNumber').value = farmer.cedulaNumber || '';

    const form = document.getElementById('farmerForm');
    form.dataset.qrCodeData = farmer.qrCodeData;

    currentQRCode = new QRCode(document.getElementById('qrcode'), {
      text: farmer.qrCodeData || farmer.farmerID,
      width: 128,
      height: 128
    });

    (farmer.farmRecords || []).forEach(record => addFarmRecordRow(record));
  } else {
    document.getElementById('farmerID').value = 'BANAYOYO-SELECT-0001';

    currentQRCode = new QRCode(document.getElementById('qrcode'), {
      text: 'BANAYOYO-SELECT-0001',
      width: 128,
      height: 128
    });

    const barangaySelect = document.getElementById('registeredBarangay');
    barangaySelect.addEventListener('change', async function () {
      const barangay = this.value;
      if (!barangay) return;

      const newID = await generateFarmerID(barangay);
      document.getElementById('farmerID').value = newID;

      document.getElementById('qrcode').innerHTML = '';
      currentQRCode = new QRCode(document.getElementById('qrcode'), {
        text: newID,
        width: 128,
        height: 128
      });
    }, { once: false });

    addFarmRecordRow();
  }
}

// Close Modal
function closeModal() {
  document.getElementById('farmerModal').style.display = 'none';
  document.getElementById('farmerForm').reset();
  document.getElementById('farmerForm').removeAttribute('data-qrcode-data');
  document.getElementById('farmerId').value = '';
  document.getElementById('farmRecordsBody').innerHTML = '';
  document.getElementById('qrcode').innerHTML = '';
  currentQRCode = null;

  const barangaySelect = document.getElementById('registeredBarangay');
  const cloned = barangaySelect.cloneNode(true);
  barangaySelect.parentNode.replaceChild(cloned, barangaySelect);
}

// Add Farm Record Row
function addFarmRecordRow(data = {}) {
  const tbody = document.getElementById('farmRecordsBody');
  const tr = document.createElement('tr');
  const today = new Date().toISOString().split('T')[0];
  const recordDate = data && data.registrationDate ? data.registrationDate : today;

  const seasonOptions = `
    <option value="">-- Select --</option>
    <option value="Not Applicable" ${data && data.seasonType === 'Not Applicable' ? 'selected' : ''}>Not Applicable</option>
    <option value="Dry/1st Crop" ${data && data.seasonType === 'Dry/1st Crop' ? 'selected' : ''}>Dry/1st Crop</option>
    <option value="Dry/2nd Crop" ${data && data.seasonType === 'Dry/2nd Crop' ? 'selected' : ''}>Dry/2nd Crop</option>
    <option value="Wet/1st Crop" ${data && data.seasonType === 'Wet/1st Crop' ? 'selected' : ''}>Wet/1st Crop</option>
    <option value="Wet/2nd Crop" ${data && data.seasonType === 'Wet/2nd Crop' ? 'selected' : ''}>Wet/2nd Crop</option>
  `;

  const uid = Date.now() + Math.random().toString(36).substr(2, 5);

  tr.innerHTML = `
    <td><select class="record-barangay">${getBarangayOptions(data && data.barangay)}</select></td>
    <td><input type="number" step="0.01" value="${data && data.farmSize ? data.farmSize : ''}" class="record-size" required min="0" /></td>
    <td><input type="text" value="${data && data.cropType ? data.cropType : ''}" class="record-crop" placeholder="e.g., Rice, Chicken" /></td>
    <td><select class="record-season" required>${seasonOptions}</select></td>
    <td><input type="date" value="${recordDate}" class="record-date" required /></td>
    
    <!-- Tax Clearance -->
    <td>
      <input type="text" class="record-tax-number" value="${data && data.taxClearanceNumber ? data.taxClearanceNumber : ''}" placeholder="TC-2026-001" />
      <div style="margin-top:4px;">
        <input type="file" accept=".pdf" id="tax_${uid}" class="record-tax-clearance" style="display:none;" />
        <button type="button" class="load-file-btn" data-for="tax_${uid}">Choose PDF</button>
      </div>
      <div class="file-name">${(data && data.taxClearance && data.taxClearance.name) ? `<span>${data.taxClearance.name}</span>` : 'No file'}</div>
    </td>

    <!-- RSBA Form -->
    <td>
      <div style="margin-bottom:4px;">
        <input type="file" accept=".pdf" id="rsba_${uid}" class="record-rsba-form" style="display:none;" />
        <button type="button" class="load-file-btn" data-for="rsba_${uid}">Choose PDF</button>
      </div>
      <div class="file-name">${(data && data.rsbaForm && data.rsbaForm.name) ? `<span>${data.rsbaForm.name}</span>` : 'No file'}</div>
    </td>

    <td><button type="button" class="delete-row">🗑️</button></td>
  `;
  tbody.appendChild(tr);

  // File upload logic
  tr.querySelectorAll('.load-file-btn').forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.getAttribute('data-for');
      document.getElementById(targetId).click();
    };
  });

  const taxInput = tr.querySelector('.record-tax-clearance');
  const rsbaInput = tr.querySelector('.record-rsba-form');
  const taxNameDiv = tr.querySelector('.file-name:nth-of-type(1)');
  const rsbaNameDiv = tr.querySelector('.file-name:nth-of-type(2)');

  const updatePreview = (fileNameDiv, file) => {
    if (!file || !fileNameDiv) return;
    fileNameDiv.innerHTML = `<span>${file.name}</span>`;
  };

  if (data && data.taxClearance) {
    updatePreview(taxNameDiv, data.taxClearance);
    taxInput._base64File = data.taxClearance;
  }
  if (data && data.rsbaForm) {
    updatePreview(rsbaNameDiv, data.rsbaForm);
    rsbaInput._base64File = data.rsbaForm;
  }

  taxInput.onchange = async () => {
    const file = taxInput.files[0];
    if (file) {
      try {
        const result = await fileToBase64(file);
        if (result) {
          updatePreview(taxNameDiv, result);
          taxInput._base64File = result;
        }
      } catch (err) {
        alert('Error reading PDF file.');
      }
    }
  };

  rsbaInput.onchange = async () => {
    const file = rsbaInput.files[0];
    if (file) {
      try {
        const result = await fileToBase64(file);
        if (result) {
          updatePreview(rsbaNameDiv, result);
          rsbaInput._base64File = result;
        }
      } catch (err) {
        alert('Error reading PDF file.');
      }
    }
  };

  tr.querySelector('.delete-row').addEventListener('click', () => {
    tr.remove();
  });
}

// Get Barangay Options
function getBarangayOptions(selected) {
  const barangays = [
    "Bagbagotot", "Banbanaal", "Bisangol", "Cadanglaan",
    "Casilagan Norte", "Casilagan Sur", "Elefante", "Guardia",
    "Lintic", "Lopez", "Montero", "Naguimba", "Pila", "Poblacion"
  ];
  return barangays.map(b => `<option value="${b}" ${b === selected ? 'selected' : ''}>${b}</option>`).join('');
}

// Load all farmers
async function loadFarmers() {
  const transaction = db.transaction([STORE_NAME], 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  const request = store.getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Delete farmer
async function deleteFarmer(id) {
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.delete(id);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Save farmer
async function saveFarmer(farmer) {
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  store.put(farmer);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Apply Filters
function applyFilters() {
  const filters = {
    search: document.getElementById('searchInput').value.toLowerCase().trim(),
    barangay: document.getElementById('filterBarangay').value,
    crop: document.getElementById('filterCrop').value,
    season: document.getElementById('filterSeason').value,
    dateFrom: document.getElementById('filterDateFrom').value,
    dateTo: document.getElementById('filterDateTo').value
  };
  renderFarmers(filters);
}

// Get filtered farmers
async function getFilteredFarmers(filterObj = {}) {
  try {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const farmers = request.result;
        const filtered = farmers.filter(farmer => {
          const matchesSearch = !filterObj.search ||
            farmer.name.toLowerCase().includes(filterObj.search.toLowerCase());

          const matchesMainBarangay = !filterObj.barangay ||
            farmer.registeredBarangay === filterObj.barangay;

          const hasMatchingRecord = (farmer.farmRecords || []).some(r => {
            const matchesCrop = !filterObj.crop || r.cropType === filterObj.crop;
            const matchesSeason = !filterObj.season || r.seasonType === filterObj.season;
            const regDate = r.registrationDate;
            const afterStart = !filterObj.dateFrom || !regDate || regDate >= filterObj.dateFrom;
            const beforeEnd = !filterObj.dateTo || !regDate || regDate <= filterObj.dateTo;
            return matchesCrop && matchesSeason && afterStart && beforeEnd;
          });

          return matchesSearch && matchesMainBarangay && hasMatchingRecord;
        });
        resolve(filtered);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Error fetching farmers:', err);
    return [];
  }
}

// Data Sharing Functions
function uploadData() {
  loadFarmers().then(farmers => {
    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      totalFarmers: farmers.length,
      farmers: farmers.map(farmer => ({
        ...farmer,
        farmRecords: farmer.farmRecords.map(r => ({
          ...r,
          taxClearance: r.taxClearance ? {
            name: r.taxClearance.name,
            size: r.taxClearance.size,
            type: r.taxClearance.type,
            base64: r.taxClearance.base64
          } : null,
          rsbaForm: r.rsbaForm ? {
            name: r.rsbaForm.name,
            size: r.rsbaForm.size,
            type: r.rsbaForm.type,
            base64: r.rsbaForm.base64
          } : null
        }))
      }))
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `farmers-data-${new Date().toISOString().split('T')[0]}.fso`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);

    logAudit('EXPORT_DATA', `Exported ${farmers.length} farmers with attached PDFs`);
  }).catch(err => {
    console.error('Export failed:', err);
    alert('Error exporting data.');
  });
}

function downloadAndMerge() {
  const fileInput = document.getElementById('downloadDataInput');
  const file = fileInput.files[0];
  if (!file) return alert('Please select a .fso file.');

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const imported = JSON.parse(e.target.result);

      if (!imported.data || !Array.isArray(imported.data)) {
        alert('❌ Invalid or corrupted file format.');
        return;
      }

      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('farmerID');

      let addedCount = 0;

      for (const incoming of imported.data) {
        if (!incoming.farmerID) continue;

        const existing = await index.get(incoming.farmerID);
        if (!existing) {
          store.add(incoming);
          addedCount++;
        }
      }

      transaction.oncomplete = () => {
        if (addedCount > 0) {
          alert(`✅ Merged successfully! Added ${addedCount} new farmers.`);
          applyFilters();
          loadCropOptions();
          logAudit('MERGE_DATA', `Imported ${addedCount} new farmers with PDFs`);
        } else {
          alert('ℹ️ No new farmers were added. All IDs already exist.');
        }
        fileInput.value = '';
      };

      transaction.onerror = (err) => {
        console.error('Transaction error:', err);
        alert('Failed to merge due to database error.');
      };

    } catch (err) {
      console.error('Parse error:', err);
      alert('❌ Failed to read file. Invalid JSON.');
    }
  };
  reader.readAsText(file);
}

// Apply Role Permissions
function applyRolePermissions() {
  const user = getCurrentUser();
  if (!user) return;

  const isAdmin = user.role === 'Administrator';
  const isEncoder = user.role === 'Encoder';
  const canEdit = isAdmin || isEncoder;

  document.getElementById('addFarmerBtn').style.display = canEdit ? 'block' : 'none';
  document.getElementById('backupBtn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('restoreBtn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('uploadDataBtn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('downloadDataBtn').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('auditSection').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('userManagementSection').style.display = isAdmin ? 'block' : 'none';
}

// Load Audit Trail
async function loadAuditTrail() {
  const user = getCurrentUser();
  const section = document.getElementById('auditSection');
  if (!user || user.role !== 'Administrator') {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  const tbody = document.getElementById('auditTable').querySelector('tbody');
  tbody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';

  try {
    const transaction = db.transaction(['audit'], 'readonly');
    const store = transaction.objectStore('audit');
    const request = store.getAll();

    request.onsuccess = () => {
      const logs = request.result.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      tbody.innerHTML = '';
      logs.forEach(log => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${new Date(log.timestamp).toLocaleString()}</td>
          <td>${log.action}</td>
          <td>${log.user}</td>
          <td>${log.details.substring(0, 100)}${log.details.length > 100 ? '...' : ''}</td>
        `;
        tbody.appendChild(tr);
      });
    };
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4">Error loading logs.</td></tr>';
  }

  document.getElementById('exportAuditBtn').onclick = () => {
    const req = store.getAll();
    req.onsuccess = () => {
      const logs = req.result.map(l => ({
        Time: new Date(l.timestamp).toLocaleString(),
        Action: l.action,
        User: l.user,
        Details: l.details
      }));
      const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-trail-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    };
  };
}

// Load Users
async function loadUsers() {
  const transaction = db.transaction(['users'], 'readonly');
  const store = transaction.objectStore('users');
  const request = store.getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Save user
async function saveUser(user) {
  const transaction = db.transaction(['users'], 'readwrite');
  const store = transaction.objectStore('users');
  store.put(user);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Delete user
async function deleteUser(id) {
  const transaction = db.transaction(['users'], 'readwrite');
  const store = transaction.objectStore('users');
  store.delete(id);
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Render User List
async function renderUserList() {
  const currentUser = getCurrentUser();
  if (!currentUser || currentUser.role !== 'Administrator') return;

  const tbody = document.getElementById('userTable').querySelector('tbody');
  tbody.innerHTML = '';

  try {
    const users = await loadUsers();
    const currentUserId = parseInt(currentUser.id);

    users.forEach(u => {
      const tr = document.createElement('tr');
      const canEdit = u.id !== currentUserId;
      const statusClass = u.active ? 'status-active' : 'status-disabled';
      const statusText = u.active ? 'Active' : 'Disabled';

      let actionButtons = '';
      if (canEdit) {
        actionButtons = `
          <button class="edit-user" data-id="${u.id}">Edit</button>
          <button class="delete-user" data-id="${u.id}">Delete</button>
        `;
      } else {
        actionButtons = `<span style="color:#888;">No Action</span>`;
      }

      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${u.username}</td>
        <td>${u.name}</td>
        <td>${u.role}</td>
        <td><span class="${statusClass}">${statusText}</span></td>
        <td>${actionButtons}</td>
      `;
      tbody.appendChild(tr);
    });

    attachUserEventListeners();
  } catch (err) {
    console.error('Failed to load users:', err);
    tbody.innerHTML = '<tr><td colspan="6">Error loading users.</td></tr>';
  }
}

// Attach User Event Listeners
function attachUserEventListeners() {
  document.querySelectorAll('.edit-user').forEach(btn => {
    btn.onclick = async () => {
      const id = Number(btn.getAttribute('data-id'));
      const users = await loadUsers();
      const user = users.find(u => u.id === id);
      if (user) openUserModal('Edit User', user);
    };
  });

  document.querySelectorAll('.delete-user').forEach(btn => {
    btn.onclick = async () => {
      const id = Number(btn.getAttribute('data-id'));
      const users = await loadUsers();
      const user = users.find(u => u.id === id);
      if (!user) return;

      if (confirm(`Delete user: ${user.name} (${user.username})? This cannot be undone.`)) {
        await deleteUser(id);
        logAudit('USER_DELETE', `Deleted user: ${user.username}`);
        renderUserList();
      }
    };
  });
}

// Open User Modal
function openUserModal(title, user = null) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.display = 'block';
  modal.innerHTML = `
    <div class="modal-content">
      <span class="close-user">&times;</span>
      <h2>${title}</h2>
      <form id="userForm">
        <input type="hidden" id="userId" />
        <label>Username:
          <input type="text" id="usernameInput" required minlength="3" maxlength="20" />
        </label>
        <label>Name:
          <input type="text" id="userName" required />
        </label>
        <label>Role:
          <select id="userRole" required>
            <option value="">-- Select --</option>
            <option value="Administrator">Administrator</option>
            <option value="Encoder">Encoder</option>
            <option value="User">User</option>
          </select>
        </label>
        ${user ? '' : '<label>Password (System Generated):<br/><small id="generatedPassword" style="color:green;"></small></label>'}
      </form>
      <div class="form-actions">
        <button type="submit" form="userForm">Save User</button>
        <button type="button" class="cancel-user">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  if (user) {
    document.getElementById('userId').value = user.id;
    document.getElementById('usernameInput').value = user.username;
    document.getElementById('userName').value = user.name;
    document.getElementById('userRole').value = user.role;
  } else {
    const pw = generateTempPassword();
    document.getElementById('generatedPassword').textContent = pw;
    document.getElementById('userForm').dataset.password = pw;
  }

  function close() {
    modal.remove();
  }

  modal.querySelector('.close-user').onclick = close;
  modal.querySelector('.cancel-user').onclick = close;
  window.addEventListener('click', e => {
    if (e.target === modal) close();
  }, { once: false });

  document.getElementById('userForm').onsubmit = async (e) => {
    e.preventDefault();

    const id = document.getElementById('userId').value;
    const username = document.getElementById('usernameInput').value.trim();
    const name = document.getElementById('userName').value.trim();
    const role = document.getElementById('userRole').value;
    const password = id ? user.password : document.getElementById('userForm').dataset.password;

    if (!username || !name || !role) {
      alert('All fields are required.');
      return;
    }

    const newUser = {
      id: id ? parseInt(id) : Date.now(),
      username,
      name,
      role,
      password,
      active: true
    };

    try {
      await saveUser(newUser);
      logAudit('USER_UPDATE', `User '${username}' (${role}) was ${id ? 'edited' : 'created'}`);
      alert('User saved successfully!');
      close();
      renderUserList();
    } catch (err) {
      alert('Failed to save user.');
    }
  };
}

// Generate Temporary Password
function generateTempPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let pwd = '';
  for (let i = 0; i < 8; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

// Reset Inactivity Timer
let inactivityTimer;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    const user = getCurrentUser();
    if (user) {
      logAudit('AUTO_LOGOUT', `Auto-logged out due to inactivity`);
      localStorage.removeItem('currentUser');
      sessionStorage.clear();
      alert('You have been logged out due to inactivity.');
      window.location.href = 'login.html';
    }
  }, INACTIVITY_TIMEOUT_MS);
}

// Listen to user activity
function setupActivityListeners() {
  ['click', 'mousemove', 'keypress', 'scroll', 'touchstart'].forEach(event => {
    window.addEventListener(event, resetInactivityTimer, { passive: true });
  });
}

// Initialize Default Users
async function initDefaultUsers() {
  const countReq = db.transaction('users').objectStore('users').count();
  const userCount = await new Promise(resolve => {
    countReq.onsuccess = () => resolve(countReq.result);
  });

  if (userCount === 0) {
    const defaults = [
      { id: 1, username: "admin", name: "System Administrator", role: "Administrator", password: "admin123", active: true },
      { id: 2, username: "encoder", name: "Field Encoder", role: "Encoder", password: "enc123", active: true },
      { id: 3, username: "user", name: "Municipal Officer", role: "User", password: "user123", active: true }
    ];

    for (const u of defaults) {
      await saveUser(u);
    }

    logAudit('SYSTEM_INIT', 'Default users created');
  }
}

// Clear All Farmers
async function clearAllFarmers() {
  if (!confirm('⚠️ WARNING: You are about to delete ALL registered farmers.\nThis cannot be undone. Continue?')) {
    return;
  }

  try {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear();

    transaction.oncomplete = () => {
      alert('✅ All farmers have been deleted.');
      logAudit('CLEAR_ALL_FARMERS', 'Administrator cleared all farmer records');
      applyFilters();
      loadCropOptions();
    };

    transaction.onerror = (err) => {
      console.error('Failed to clear farmers:', err);
      alert('Error deleting farmers.');
    };
  } catch (err) {
    console.error('Transaction failed:', err);
    alert('Failed to clear data.');
  }
}

// Clear All Audit Trail
async function clearAllAuditTrail() {
  if (!confirm('⚠️ Are you sure you want to delete ALL audit logs?\nThis cannot be recovered.')) {
    return;
  }

  try {
    const transaction = db.transaction(['audit'], 'readwrite');
    const store = transaction.objectStore('audit');
    store.clear();

    transaction.oncomplete = () => {
      alert('🗑️ Audit trail has been cleared.');
      document.getElementById('auditTable').querySelector('tbody').innerHTML = '';
      logAudit('AUDIT_CLEARED', 'All audit entries were manually cleared by admin');
    };

    transaction.onerror = (err) => {
      console.error('Failed to clear audit trail:', err);
      alert('Error clearing audit logs.');
    };
  } catch (err) {
    console.error('Clear audit error:', err);
    alert('Operation failed.');
  }
}

// Initialize App
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await openDB();
    await initDefaultUsers();

    const currentUser = getCurrentUser();
    if (!currentUser) {
      window.location.href = 'login.html';
      return;
    }

    await loadCropOptions();
    applyFilters();

    applyRolePermissions();

    resetInactivityTimer();
    setupActivityListeners();

    const wasLogged = sessionStorage.getItem('loginEventLogged');
    if (!wasLogged) {
      logAudit('LOGIN_SUCCESS', `User '${currentUser.username}' logged in as ${currentUser.role}`);
      sessionStorage.setItem('loginEventLogged', 'true');
    }

    // Attach Events
    document.getElementById('addFarmerBtn').addEventListener('click', () => openModal('Add Farmer'));

    // ✅ FORM SUBMIT HANDLER (Works for Encoder!)
    document.getElementById('farmerForm').addEventListener('submit', async function(e) {
      e.preventDefault();

      const id = document.getElementById('farmerId').value;
      const farmerIDInput = document.getElementById('farmerID').value;

      const duplicate = await loadFarmers().then(fs =>
        fs.find(f => f.farmerID === farmerIDInput && (!id || f.id != id))
      );
      if (duplicate) {
        alert(`Error: Farmer ID "${farmerIDInput}" already exists.`);
        return;
      }

      const existingTaxNumbers = new Set();
      const allFarmers = await loadFarmers();
      allFarmers.forEach(farmer => {
        if (id && farmer.id == id) return;
        if (farmer.farmRecords && Array.isArray(farmer.farmRecords)) {
          farmer.farmRecords.forEach(r => {
            if (r.taxClearanceNumber) {
              existingTaxNumbers.add(r.taxClearanceNumber.trim());
            }
          });
        }
      });

      const usedTaxNumbers = [];
      let hasDuplicateInForm = false;
      let hasGlobalConflict = false;

      document.querySelectorAll('#farmRecordsBody tr').forEach(row => {
        const taxNumber = (row.querySelector('.record-tax-number')?.value || '').trim();
        if (taxNumber) {
          if (usedTaxNumbers.includes(taxNumber)) {
            hasDuplicateInForm = true;
          }
          usedTaxNumbers.push(taxNumber);

          if (existingTaxNumbers.has(taxNumber)) {
            hasGlobalConflict = true;
          }
        }
      });

      if (hasDuplicateInForm) {
        alert("⚠️ Duplicate Tax Clearance Number within form.");
        return;
      }

      if (hasGlobalConflict) {
        alert("🚫 One or more Tax Clearance Numbers are already used by other farmers.");
        return;
      }

      const farmer = {
        name: document.getElementById('name').value.trim(),
        registeredBarangay: document.getElementById('registeredBarangay').value,
        age: Number(document.getElementById('age').value),
        sex: document.getElementById('sex').value,
        cedulaNumber: document.getElementById('cedulaNumber').value,
        farmerID: farmerIDInput,
        farmRecords: []
      };

      if (id) farmer.id = Number(id);

      document.querySelectorAll('#farmRecordsBody tr').forEach(row => {
        const barangay = row.querySelector('.record-barangay').value;
        const farmSize = row.querySelector('.record-size').value;
        const cropType = row.querySelector('.record-crop').value;
        const seasonType = row.querySelector('.record-season').value;
        const registrationDate = row.querySelector('.record-date').value;
        const taxNumber = (row.querySelector('.record-tax-number').value || '').trim();

        const taxFile = row.querySelector('.record-tax-clearance')?._base64File;
        const rsbaFile = row.querySelector('.record-rsba-form')?._base64File;

        if (barangay && farmSize && seasonType && registrationDate) {
          farmer.farmRecords.push({
            barangay,
            farmSize: parseFloat(farmSize),
            cropType,
            seasonType,
            registrationDate,
            taxClearanceNumber: taxNumber || null,
            taxClearance: taxFile ? { ...taxFile } : null,
            rsbaForm: rsbaFile ? { ...rsbaFile } : null
          });
        }
      });

      const form = document.getElementById('farmerForm');
      if (id && form.dataset.qrCodeData) {
        farmer.qrCodeData = form.dataset.qrCodeData;
      } else {
        farmer.qrCodeData = generateUniqueQRData(farmer.farmerID, farmer.name);
      }

      try {
        await saveFarmer(farmer);
        logAudit('SAVE_FARMER', `Saved farmer: ${farmer.name} (ID: ${farmer.farmerID})`);
        closeModal();
        applyFilters();
        await loadCropOptions();
      } catch (err) {
        console.error('Save failed:', err);
        alert('Failed to save farmer.');
      }
    });

    // ✅ CLOSE BUTTONS (Work for Encoders)
    document.getElementById('cancelBtn')?.addEventListener('click', closeModal);
    document.querySelector('.close')?.addEventListener('click', closeModal);
    window.addEventListener('click', e => {
      const modal = document.getElementById('farmerModal');
      if (e.target === modal) closeModal();
    });

    // Add Row Button
    document.getElementById('addRowBtn').addEventListener('click', addFarmRecordRow);

    // Filters
    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('filterBarangay').addEventListener('change', applyFilters);
    document.getElementById('filterCrop').addEventListener('change', applyFilters);
    document.getElementById('filterSeason').addEventListener('change', applyFilters);
    document.getElementById('filterDateFrom').addEventListener('change', applyFilters);
    document.getElementById('filterDateTo').addEventListener('change', applyFilters);

    document.getElementById('clearFilter').addEventListener('click', () => {
      document.getElementById('searchInput').value = '';
      document.getElementById('filterBarangay').value = '';
      document.getElementById('filterCrop').value = '';
      document.getElementById('filterSeason').value = '';
      document.getElementById('filterDateFrom').value = '';
      document.getElementById('filterDateTo').value = '';
      applyFilters();
      loadCropOptions();
    });

    // Print Report
    document.getElementById('printReportBtn').addEventListener('click', async () => {
      const filters = {
        search: document.getElementById('searchInput').value.trim(),
        barangay: document.getElementById('filterBarangay').value,
        crop: document.getElementById('filterCrop').value,
        season: document.getElementById('filterSeason').value,
        dateFrom: document.getElementById('filterDateFrom').value,
        dateTo: document.getElementById('filterDateTo').value
      };
      await printReport(filters);
    });

    // Backup & Restore
    document.getElementById('backupBtn').addEventListener('click', () => {
      loadFarmers().then(farmers => {
        const blob = new Blob([JSON.stringify(farmers, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `farmers-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        logAudit('BACKUP', 'Backup created with embedded PDFs');
      });
    });

    document.getElementById('restoreBtn').addEventListener('click', () => {
      const file = document.getElementById('restoreInput').files[0];
      if (!file) return alert('Please select a file.');
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const farmers = JSON.parse(e.target.result);
          const tx = db.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          farmers.forEach(f => store.add(f));
          tx.oncomplete = () => {
            alert('Database restored!');
            applyFilters();
            loadCropOptions();
            logAudit('RESTORE', 'Database restored from backup with PDFs');
          };
        } catch (err) {
          alert('Invalid file.');
        }
      };
      reader.readAsText(file);
    });

    // Data Sharing
    document.getElementById('uploadDataBtn').addEventListener('click', uploadData);
    document.getElementById('downloadDataBtn').addEventListener('click', () => {
      document.getElementById('downloadDataInput').click();
    });
    document.getElementById('downloadDataInput').addEventListener('change', function () {
      if (this.files.length > 0) downloadAndMerge();
    });

    // Logout Button
    document.getElementById('logoutBtn').addEventListener('click', () => {
      const user = getCurrentUser();
      logAudit('LOGOUT', `User '${user.username}' manually logged out`);
      localStorage.removeItem('currentUser');
      sessionStorage.clear();
      window.location.href = 'login.html';
    });

    // Load Audit Trail and User Management
    loadAuditTrail();
    renderUserList();

    document.getElementById('addUserBtn')?.addEventListener('click', () => {
      openUserModal('Add New User');
    });

    // Administrative Clear Buttons
    const dangerSection = document.querySelector('.danger-section');
    if (currentUser.role === 'Administrator') {
      dangerSection.style.display = 'block';
      document.getElementById('clearFarmersBtn').addEventListener('click', clearAllFarmers);
      document.getElementById('clearAuditBtn').addEventListener('click', clearAllAuditTrail);
    } else {
      dangerSection.style.display = 'none';
    }

    // Initial render
    applyFilters();

  } catch (err) {
    console.error('App init failed:', err);
    alert('Failed to initialize app.');
  }
});

// ✅ GLOBAL EVENT DELEGATION FOR .close-view BUTTONS
document.addEventListener('click', function(e) {
  const isCloseBtn = e.target.classList.contains('close-view') ||
                     e.target.closest('.close-view');

  if (!isCloseBtn) return;

  const modal = document.getElementById('viewModal');
  if (modal) {
    modal.style.display = 'none';
    document.getElementById('viewContent').innerHTML = '';
  }
});

// Allow clicking outside view modal to close
window.addEventListener('click', (e) => {
  const modal = document.getElementById('viewModal');
  if (e.target === modal) {
    modal.style.display = 'none';
    document.getElementById('viewContent').innerHTML = '';
  }
});
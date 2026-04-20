const fs = require('fs');
fetch("https://us-central1-pizarraflc.cloudfunctions.net/analyzeReceipt", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        base64Image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", // Tiny transparent PNG 
        mimeType: "image/png"
    })
}).then(res => res.text()).then(txt => console.log(txt)).catch(e => console.error(e));

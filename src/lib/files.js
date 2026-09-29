// Compresse une photo côté téléphone avant stockage (pas de service payant nécessaire).
// Réduit taille + qualité jusqu'à tenir dans la limite d'un document Firestore.
export function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const maxDim = 1000;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.7;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length > 700000 && quality > 0.15) {
          quality -= 0.15;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        if (dataUrl.length > 900000) {
          reject(new Error("too_big"));
        } else {
          resolve(dataUrl);
        }
      };
      img.onerror = () => reject(new Error("invalid_image"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

// Ouvre un PDF stocké en base64 de façon fiable sur mobile — un lien <a href
// download> sur une "data URL" est souvent ignoré silencieusement par Safari
// iOS. On passe par un Blob, que le navigateur sait afficher/télécharger
// correctement dans un nouvel onglet.
export async function openPdfDocument(dataUrl, filename) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, "_blank");
    if (!win) {
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename || "bon-transport.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (e) {
    window.open(dataUrl, "_blank");
  }
}

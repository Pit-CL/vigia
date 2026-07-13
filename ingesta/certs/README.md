# Certificados vendorizados

`globalsign-alphassl-2025.pem`: intermedio "GlobalSign GCC R6 AlphaSSL CA 2025" (descargado del AIA `http://secure.globalsign.com/cacert/gsgccr6alphasslca2025.crt`). Se necesita porque `www.sernageomin.cl` (fallback de volcanes) sirve solo el certificado hoja, sin la cadena completa, y el verificador TLS de Python no la completa solo.
Expira 2027-05-21 (`notAfter`); cuando falle la verificación después de esa fecha, volver a descargar el intermedio vigente del mismo AIA y reemplazar este archivo.

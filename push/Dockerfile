# Único contenedor del proyecto con dependencias pip (pywebpush): el resto
# de Vigía es stdlib puro. El código de push/ va montado, no copiado — este
# build solo instala la librería.
FROM python:3.12-alpine
RUN pip install --no-cache-dir pywebpush==2.3.0

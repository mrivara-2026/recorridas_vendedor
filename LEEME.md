# Recorridas — guía de instalación y uso

Sistema para las recorridas del vendedor:

- **App del celular** (`/app`): el vendedor elige zona y cantidad de visitas, sigue la recorrida sugerida, marca SÍ/NO (se guardan hora y ubicación), saca la foto (local o góndola), deja comentarios y termina la jornada (se guarda la ubicación de cierre).
- **Panel web** (`/panel`): clientes (tabla editable + importación de Excel sin duplicados), zonas del mes con mapa, base de visitas con exportación a Excel y, solo para el administrador, **control de jornada**.

## Usuarios iniciales

| Usuario | Rol | Ve |
|---|---|---|
| `plateroadmin` | Administrador | Clientes, Zonas del mes, Visitas, **Control de jornada** |
| `msayago` | Vendedor | App del celular + panel web sin Control de jornada |

Las contraseñas iniciales se definen en el primer arranque con las variables `ADMIN_PASS` y `VENDOR_PASS` (no están escritas en el código). **Cambiá las dos la primera vez que entres** (botón "Cambiar contraseña" en el panel web).

## Publicarlo en internet

El sistema necesita **HTTPS**: sin HTTPS el celular no permite usar el GPS. Cualquier servicio de hosting moderno lo da de forma automática.

Necesita:
- Node.js 20 o superior (o Docker, hay un `Dockerfile` incluido).
- Una **carpeta persistente** para la base de datos y las fotos. Se indica con la variable `DATA_DIR` (en Docker es `/data`).

### Opción gratuita: Oracle Cloud Always Free

1. Subí esta carpeta a un repositorio de GitHub (público: el código no contiene contraseñas).
2. En Oracle Cloud creá un servidor Ubuntu "Always Free" y en *Initialization script* subí `instalar-oracle.sh` con tus datos completos (repositorio y contraseñas iniciales).
3. En la red del servidor (Security List) abrí los puertos 80 y 443.
4. A los 10 minutos el sistema queda en `https://<IP-con-guiones>.sslip.io` (por ejemplo `https://150-230-1-2.sslip.io`).
5. Para actualizar a una versión nueva: subirla a GitHub y en el servidor ejecutar `sudo actualizar-recorridas`.

Copias de seguridad diarias de la base en `/var/backups/recorridas` (se guardan 30 días). Registro de la instalación: `/var/log/recorridas-instalacion.log`.

### Opción A: Railway o Render (pago, sin servidor propio)

1. Subí esta carpeta a un repositorio de GitHub (privado).
2. En Railway o Render, creá un servicio nuevo desde ese repositorio. Detecta el `Dockerfile` solo.
3. Agregá un **volumen / disco persistente** montado en `/data`. Este paso es importante: sin él, la base y las fotos se borran en cada actualización.
4. Si querés, cargá las variables `ADMIN_PASS` y `VENDOR_PASS` antes del primer arranque.
5. Publicá. Te da una dirección `https://…` que es la que usan los dos.

Revisá el precio vigente del plan con disco persistente en el sitio del proveedor.

### Opción B: servidor propio

```bash
npm ci --omit=dev
DATA_DIR=/ruta/a/datos PORT=3000 node server.js
```

Poné un proxy con HTTPS adelante (por ejemplo Caddy o Nginx).

## En el celular del vendedor

1. Abrir la dirección del sistema en Chrome (Android) o Safari (iPhone) e ingresar con su usuario.
2. Cuando lo pida, **permitir la ubicación** y la cámara.
3. Menú del navegador → **"Agregar a pantalla de inicio"**: queda como una app.
4. La sesión queda abierta 30 días en ese celular.

Cómo usarla bien: marcar **SÍ/NO al llegar** al local y tocar **Guardar al irse**. Así se mide el tiempo en cada visita. Al final del día, siempre **Terminar jornada**.

## Cómo funciona

- **Importar Excel**: usá la plantilla ("Descargar plantilla" en Clientes). Cada archivo se suma a la base. Una sucursal se considera la misma si tiene la misma ubicación (a menos de 15 m) o el mismo nombre y dirección: en ese caso se actualiza, no se duplica. Antes de confirmar ves un resumen con nuevas, actualizadas, sin cambios, posibles repetidos y filas con error.
- **Sugerencias**: primero las que quedaron pendientes (NO, o sin visitar al terminar la jornada); después las más cercanas entre sí que no tuvieron visita SÍ en el mes. El orden empieza en la ubicación del vendedor.
- **Control de jornada**: inicio, cada visita (llegada, salida, minutos, distancia a la sucursal), hora y ubicación de cada foto, traslados, tiempo sin actividad y fin de jornada con su ubicación. Alertas si una foto o una visita se marcó a más de 300 m de la sucursal, si hubo más de 1 hora sin actividad antes del cierre o si no tocó "Terminar jornada".
- **Tiempos estimados**: promedio de los últimos 30 días por tipo de cliente (BEC/MAN) y de los traslados. Se usan para estimar la duración de cada recorrida.

## Copias de seguridad

Todo está en la carpeta de datos (`recorridas.db` y la carpeta `fotos`). Copiala periódicamente. Además, desde Visitas podés exportar el Excel con todo.

## Pruebas

`python3 tests/e2e.py` levanta el sistema con una base vacía y prueba todas las funciones con un navegador real (requiere Python con `playwright`, `openpyxl` y `Pillow`).

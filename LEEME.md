# Sistema de visitas — guía de instalación y uso (versión 2)

Sistema de visitas del vendedor de Platero, para Serrana (Manirux) y Becarey:

- **Panel web** (`/panel`): el jefe comercial arma la semana del vendedor eligiendo barrios; el sistema suma los barrios linderos y sugiere primero las sucursales del grupo Disco con caída de ventas, después las visitas que quedaron pendientes y después los comercios a los que les toca visita por frecuencia. También: comercios, ventas Serrana, visitas, dashboard con alertas, control de jornada y configuración de barrios y listas.
- **App del celular** (`/app`): el vendedor ve lo que tiene hoy y en la semana, inicia la jornada (se ordena el recorrido desde donde está), completa el formulario de cada visita (SÍ/NO, motivo si fue NO, foto, comentarios estándar, comentario libre y, en prospectos, cuándo volver o si pasó a cliente), agrega urgencias (le avisan al jefe) y termina la jornada.

## Qué cambió respecto de la versión 1

| Versión 1 | Versión 2 |
|---|---|
| El vendedor elegía zona y cantidad cada mañana | El administrador arma y publica la semana. El vendedor igual puede armar una recorrida en un barrio si no tiene visitas asignadas |
| Cada sucursal una vez por mes | Frecuencia por comercio: Serrana 2 o 3 por año, Cliente BEC 1 o 2, Prospecto BEC según lo que pidió |
| Zonas aisladas | Barrios con sus linderos (editables en *Barrios y listas*) |
| Solo BEC o MAN | Tipos: Serrana, Cliente BEC, Prospecto BEC (y cadena: Grupo Disco, Tienda Inglesa, Otra) |
| Sin datos de ventas | Carga de la *Consulta Factura Sucursal* de GIA y regla de caída del grupo Disco |
| Comentario libre | Motivo del NO, comentarios estándar por tipo y comentario libre |
| El link de Google Maps era obligatorio | Es opcional: sin link, el sistema ubica el comercio por su dirección (OpenStreetMap) |
| — | Urgencias, alertas para el jefe y dashboard (cumplimiento, visitas por semana, horas, prospectos a cliente) |

La base de datos de la versión 1 se actualiza sola al arrancar: no se pierde nada. Los comercios MAN pasan a Serrana (3 visitas por año) y los BEC a Cliente BEC (2 por año).

### Regla de caída de ventas (grupo Disco)

Una sucursal de Disco, Devoto, Devoto Express o Geant (Ameluz, Odaler) es prioridad si:

1. en los últimos 90 días vendió 30% o menos que en los mismos 90 días del año anterior (packs, descontando notas de crédito), o
2. pasó más del doble del tiempo que suele tardar entre una compra y la siguiente.

Se calcula a la última fecha de la planilla de ventas. Para vincular cada sucursal con su comercio, el comercio tiene que tener el **Código ventas** (DISCO18, DEV3016…).

## Usuarios

| Usuario | Rol | Ve |
|---|---|---|
| `plateroadmin` | Administrador (jefe comercial) | Todo: armar semana, dashboard y alertas, comercios, ventas, visitas, control de jornada, barrios y listas |
| `msayago` | Vendedor | App del celular + panel web: su semana, su dashboard, comercios y sus visitas |

Las contraseñas iniciales se definen en el primer arranque con `ADMIN_PASS` y `VENDOR_PASS`. Se cambian desde el panel ("Cambiar contraseña").

## Carga inicial

1. Panel → **Comercios** → *Elegir archivo* → subir `Comercios_sistema_visitas.xlsx` (o la plantilla `plantillas/Plantilla_Comercios.xlsx` completa). Si el archivo trae las hojas *Barrios* y *Listas*, también se cargan.
2. Panel → **Ventas Serrana** → subir la *Consulta Factura Sucursal* tal como sale de GIA (o `plantillas/Plantilla_Ventas_Serrana.xlsx`).
3. Panel → **Armar semana** → elegir barrios, marcar los sugeridos, asignarlos a un día y **Publicar semana**.

Los comercios sin link de Maps se ubican de a uno (más o menos uno por segundo). En Comercios se ve el estado: *Ubicado*, *Aproximado* (solo se encontró el barrio) o *Sin ubicación*. En esos casos conviene pegar el link de Google Maps con el botón **Link**.

## Actualizar un servidor que ya tiene la versión 1

1. Subir esta versión al mismo repositorio de GitHub.
2. En el servidor, hacer una copia de la base por las dudas:
   `sudo sqlite3 /var/lib/recorridas/recorridas.db ".backup /var/backups/recorridas/antes-v2.db"`
3. Ejecutar `sudo actualizar-recorridas`.

No hace falta cambiar nada más. Variables opcionales en `/etc/recorridas.env`:

- `GEOCODER_EMAIL=correo@empresa.com`: se envía a OpenStreetMap para identificar al sistema (lo piden en su política de uso).
- `GEOCODER=off`: apaga la ubicación automática por dirección.

El servidor necesita salida a internet por HTTPS hacia `nominatim.openstreetmap.org` (en AWS la salida está abierta por defecto).

## Instalación nueva

Necesita **HTTPS** (sin HTTPS el celular no deja usar el GPS), Node.js 20 o superior (o Docker, hay un `Dockerfile`) y una **carpeta persistente** para la base y las fotos (`DATA_DIR`; en Docker es `/data`).

- **Servidor Ubuntu (AWS EC2, Lightsail u Oracle Cloud):** en *User data / Initialization script* pegar `instalar-oracle.sh` con los datos completos (repositorio y contraseñas iniciales). Abrir los puertos 80 y 443. A los 10 minutos queda en `https://<IP-con-guiones>.sslip.io`.
- **Railway o Render:** crear el servicio desde el repositorio (detecta el `Dockerfile`) y agregar un disco persistente montado en `/data`.
- **Servidor propio:** `npm ci --omit=dev` y `DATA_DIR=/ruta/a/datos PORT=3000 node server.js`, con un proxy HTTPS adelante (Caddy o Nginx).

Copias de seguridad diarias en `/var/backups/recorridas` (30 días).

## En el celular del vendedor

1. Abrir la dirección del sistema en Chrome (Android) o Safari (iPhone) e ingresar.
2. **Permitir la ubicación** y la cámara.
3. Menú del navegador → **"Agregar a pantalla de inicio"**.

Uso: **Iniciar jornada** al salir; en cada comercio marcar **SÍ/NO al llegar** y **Guardar** al irse; **Terminar jornada** al final del día.

## Pruebas

`npm test` levanta el sistema con una base vacía y datos inventados y prueba la importación, la regla de caída, la semana, la jornada, las urgencias y el dashboard.

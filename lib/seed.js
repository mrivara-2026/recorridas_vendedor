'use strict';
// Datos iniciales: barrios linderos y listas de comentarios. Se cargan solo si las tablas están vacías;
// después se editan desde el panel (Configuración) o subiendo la planilla de comercios.

const COSTA = ['Barra de Carrasco', 'Shangrilá', 'Lagomar', 'Solymar', 'Médanos de Solymar', 'El Pinar'];

const BARRIOS = {
  'Centro': ['Cordón', 'Barrio Sur', 'Aguada', 'Ciudad Vieja'],
  'Ciudad Vieja': ['Centro'],
  'Barrio Sur': ['Centro', 'Cordón', 'Palermo'],
  'Palermo': ['Barrio Sur', 'Cordón', 'Parque Rodó'],
  'Parque Rodó': ['Palermo', 'Cordón', 'Pocitos', 'Punta Carretas'],
  'Cordón': ['Centro', 'Barrio Sur', 'Palermo', 'Parque Rodó', 'Tres Cruces', 'Aguada'],
  'Aguada': ['Centro', 'Cordón', 'Tres Cruces', 'Villa Muñoz', 'Goes', 'Reducto', 'Bella Vista'],
  'Tres Cruces': ['Cordón', 'Aguada', 'Villa Muñoz', 'La Blanqueada', 'Parque Batlle'],
  'Villa Muñoz': ['Aguada', 'Goes', 'Tres Cruces', 'La Blanqueada'],
  'Goes': ['Villa Muñoz', 'Aguada', 'Reducto', 'Brazo Oriental'],
  'Reducto': ['Goes', 'Aguada', 'Bella Vista', 'Prado', 'Brazo Oriental'],
  'Bella Vista': ['Prado', 'Reducto', 'Aguada'],
  'Prado': ['Bella Vista', 'Reducto', 'Brazo Oriental', 'Belvedere', 'Sayago'],
  'Brazo Oriental': ['Prado', 'Reducto', 'Goes', 'Cerrito'],
  'Cerrito': ['Brazo Oriental', 'Mercado Modelo'],
  'Belvedere': ['Prado', 'La Teja', 'Sayago'],
  'La Teja': ['Belvedere', 'Paso de la Arena'],
  'Sayago': ['Belvedere', 'Prado', 'Colón'],
  'Colón': ['Sayago'],
  'Paso de la Arena': ['La Teja'],
  'Mercado Modelo': ['La Blanqueada', 'Unión', 'Cerrito'],
  'La Blanqueada': ['Parque Batlle', 'Tres Cruces', 'Villa Muñoz', 'Unión', 'Buceo', 'Mercado Modelo'],
  'Parque Batlle': ['Pocitos', 'Tres Cruces', 'La Blanqueada', 'Buceo'],
  'Pocitos': ['Punta Carretas', 'Parque Batlle', 'Buceo', 'Parque Rodó'],
  'Punta Carretas': ['Pocitos', 'Parque Rodó'],
  'Buceo': ['Pocitos', 'Parque Batlle', 'La Blanqueada', 'Unión', 'Malvín', 'Malvín Norte'],
  'Unión': ['Buceo', 'La Blanqueada', 'Mercado Modelo', 'Malvín Norte', 'Maroñas'],
  'Maroñas': ['Unión', 'Malvín Norte', 'Piedras Blancas'],
  'Piedras Blancas': ['Maroñas'],
  'Malvín': ['Buceo', 'Malvín Norte', 'Punta Gorda'],
  'Malvín Norte': ['Malvín', 'Buceo', 'Unión', 'Maroñas', 'Punta Gorda', 'Carrasco Norte'],
  'Punta Gorda': ['Malvín', 'Malvín Norte', 'Carrasco', 'Carrasco Norte'],
  'Carrasco': ['Punta Gorda', 'Carrasco Norte', 'Barra de Carrasco'],
  'Carrasco Norte': ['Carrasco', 'Punta Gorda', 'Malvín Norte'],
  'Barra de Carrasco': ['Carrasco', 'Carrasco Norte', 'Shangrilá'],
  'Shangrilá': ['Barra de Carrasco', 'Lagomar'],
  'Lagomar': ['Shangrilá', 'Solymar'],
  'Solymar': ['Lagomar', 'Médanos de Solymar', 'El Pinar'],
  'Médanos de Solymar': ['Solymar', 'El Pinar'],
  'El Pinar': ['Solymar', 'Médanos de Solymar']
};

const LISTAS = {
  comentario_prospecto: ['Interesado, volver a contactar', 'No interesado', 'Quiere para el próximo pedido', 'Quiere que volvamos en un tiempo', 'Ya tiene proveedor', 'Pidió lista de precios', 'Hablar con el dueño o encargado', 'Otro'],
  comentario_cliente: ['Todo OK', 'Mala calidad del producto', 'Revisar últimas compras', 'Pidió reposición', 'Reclamo de entrega', 'Quiere cambiar producto o cantidad', 'Otro'],
  comentario_serrana: ['Todo OK', 'Falta de stock', 'Producto mal exhibido', 'Piden reposición', 'No está el encargado', 'Precio mal marcado', 'Otro'],
  motivo_no: ['Cerrado', 'No estaba el encargado', 'No llegué a tiempo', 'Otro']
};

const LISTA_NOMBRES = {
  comentario_prospecto: 'Comentarios Prospecto BEC',
  comentario_cliente: 'Comentarios Cliente BEC',
  comentario_serrana: 'Comentarios Serrana',
  motivo_no: 'Motivos de NO visita'
};

module.exports = { COSTA, BARRIOS, LISTAS, LISTA_NOMBRES };

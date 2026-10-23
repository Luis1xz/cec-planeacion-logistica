# Tablero de Planeación Logística · CEC | Universidad del Norte 🎓

Plataforma ejecutiva e interactiva de monitoreo, gestión y control de cursos y programas académicos del **Centro de Educación Continuada (CEC)** de la **Universidad del Norte**.

Sincronización en la nube en tiempo real mediante **Firebase Realtime Database**, integración con **Google Drive / Sheets**, y panel de visualización dedicado **Modo TV / Kiosko** para salas de monitoreo y pantallas de pared.

---

## 📺 Modo TV / Kiosko para Pantallas y Televisores

Diseñado específicamente para dejar en un televisor de oficina, pantalla informativa o monitor de operaciones en tiempo real:

- **Reloj Digital en Vivo:** Hora exacta con segundero en tiempo real y fecha completa en español.
- **Auto-Scroll Inteligente:** Desplazamiento automático y continuo para recorrer todas las alertas y tareas pendientes sin necesidad de mouse ni control remoto. Pausa inteligente al interactuar y reanudación automática tras 8 segundos.
- **3 Columnas de Supervisión en Tiempo Real:**
  1. 🚨 **Urgente & Alertas Rojas:** Programas con semáforo rojo, tabulaciones vencidas, salones pendientes y reprogramaciones críticas.
  2. 🗓️ **Clases Activas & Próximos Inicios:** Cursos en desarrollo hoy, modalidades (Presencial / Remoto / Blended), horarios y salones confirmados.
  3. 📋 **Tabulaciones & Recordatorios:** Tareas pendientes organizadas por coordinadora (Patricia, Andrea, Liliam, Karen).
- **Ribbon Superior de KPIs:** Contadores grandes de alertas críticas, tabulaciones vencidas, salones por resolver, solicitudes por correo y cursos en marcha.
- **Temas Adaptables:** Modo Noche (OLED de alto contraste anti-reflejo) y Modo Día.
- **Acceso Directo Kiosko:** Agrega `#tv` a la URL (ej. `https://cec-logistica.vercel.app/#tv`) para que cualquier Smart TV, Chromecast o tablet abra automáticamente en pantalla completa.
- **Atajos de Teclado:**
  - `T`: Alternar Modo TV
  - `F11`: Pantalla Completa
  - `Esc`: Salir a la vista de edición

---

## 🚀 Características Principales del Tablero

- **Semáforo Inteligente de Estado:**
  - 🔴 **Rojo:** Requiere acción inmediata (tabulación vencida, salón no asignado o reprogramado).
  - 🟡 **Amarillo:** Seguimiento preventivo o fecha próxima de inicio.
  - 🟢 **Verde:** Confirmado, al día y operando con normalidad.
- **Filtros Rápidos en Barra de Herramientas:**
  - Filtro instantáneo por semáforo (Todos / Críticos / Seguimiento / Al día).
  - Selector rápido por coordinadora y por mes de planeación.
  - Buscador reactivo en tiempo real por nombre de programa, código o NRC.
- **Gestión Integral de Programas:**
  - Creación y edición con diseñador interactivo de franjas horarias y días de clase.
  - Asignación de salones, enlaces Zoom/Teams y seguimiento de encuestas de satisfacción.
- **Matriz de Asistencia Interactiva:**
  - Tabulación rápida por sesiones (Presente, Falta, Excusa).
  - Sincronización bidireccional con hojas de cálculo de Google Drive.
  - Exportación a Excel (.xlsx).
- **Bandeja de Correos de Apertura:**
  - Recepción y procesamiento directo de solicitudes de apertura de cursos.
- **Notificaciones Toast:**
  - Notificaciones flotantes animadas para confirmaciones de guardado y alertas en tiempo real.

---

## 🛠️ Tecnologías Utilizadas

- **Frontend:** Vanilla JavaScript moderno (ES6+), HTML5 Semántico, CSS3 con variables CSS y Glassmorphism.
- **Base de Datos en Tiempo Real:** Google Firebase Realtime Database.
- **Procesamiento de Archivos:** SheetJS (XLSX).
- **Tipografía:** Outfit, Plus Jakarta Sans, JetBrains Mono.
- **Despliegue:** Vercel & GitHub.

---

## 💻 Ejecución Local

Para correr el proyecto localmente sin dependencias complejas:

```bash
# Con cualquier servidor estático local (Node.js)
npx serve public

# O usando Python
python -m http.server 3000 --directory public
```

---

Desarrollado para el **CEC · Universidad del Norte** — Barranquilla, Colombia.

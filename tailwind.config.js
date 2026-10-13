/** Tailwind solo para el dashboard: se compila a public/tailwind.css.
 *  Antes se cargaba el CDN (script en tiempo de ejecución con eval), lo que
 *  impedía usar una CSP estricta. Con el build local ya no hace falta
 *  'unsafe-eval'.
 */
module.exports = {
  content: ['./public/index.html', './public/login.html', './public/dashboard.js', './public/panels.js', './public/login.js'],
  theme: { extend: {} },
  plugins: [],
};

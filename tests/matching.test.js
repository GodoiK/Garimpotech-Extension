// Testes do motor de correspondência (sem dependências): `npm test`
const test = require("node:test");
const assert = require("node:assert/strict");
const CP = require("../extension/stores.js");
const { tokens, coreModel, buildSpec, relevant, parsePrice, median, detectBrand } = CP;

const gpu = buildSpec("RTX 4060 MSI", { generic: true, junk: true, systems: true });
const ok = (title, spec = gpu) => relevant({ title, price: 1 }, spec);

test("tokenização separa letras e números", () => {
  assert.deepEqual(tokens("RTX4060Ti 8GB"), ["rtx", "4060", "ti", "8", "gb"]);
  assert.deepEqual(tokens("Ryzen 7 5800X3D"), ["ryzen", "7", "5800", "x", "3", "d"]);
});

test("parsePrice entende formatos brasileiros", () => {
  assert.equal(parsePrice("R$ 1.299,90"), 1299.9);
  assert.equal(parsePrice("1299.90"), 1299.9);
  assert.equal(parsePrice("1.299"), 1299);
  assert.equal(parsePrice("grátis"), null);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("busca genérica remove marca e linha do fabricante", () => {
  assert.equal(gpu.query, "rtx 4060");
  assert.equal(coreModel("Placa de Vídeo MSI RTX 4060 Ventus 2X 8GB GDDR6").query, "rtx 4060 8gb");
});

test("GPU: mesma série de qualquer marca entra", () => {
  assert.ok(ok("Placa De Vídeo Gigabyte Geforce RTX 4060 Windforce Oc 8gb"));
  assert.ok(ok("Galax RTX4060 1-Click OC 8GB"));
});

test("GPU: variantes e outras séries ficam de fora", () => {
  assert.ok(!ok("Placa de Vídeo RTX 4060 Ti 8GB Zotac"));
  assert.ok(!ok("Placa de Vídeo RTX 3060 12GB"));
  const ti16 = buildSpec("RTX 4060 Ti 16GB", { generic: true });
  assert.ok(!ok("RTX 4060 Ti 8GB", ti16)); // memória diferente
  assert.ok(ok("RTX 4060 Ti 16GB", ti16));
});

test("GPU: anúncio de usado sem a palavra RTX é aceito; outra série não", () => {
  assert.ok(ok("Placa de Vídeo 4060 8gb Galax"));
  const gt = buildSpec("GT 1030", { generic: true });
  assert.ok(!ok("Placa de Vídeo GTX 1030 2GB", gt));
});

test("CPU: sufixo importa (5600 != 5600X != 5600G)", () => {
  const x = buildSpec("Processador AMD Ryzen 5 5600X", { generic: true });
  assert.equal(x.query, "ryzen 5 5600x");
  assert.ok(ok("Ryzen 5 5600X AM4 Usado", x));
  assert.ok(!ok("Processador AMD Ryzen 5 5600 AM4", x));
  assert.ok(!ok("Ryzen 5 5600G com Vega", x));
  assert.equal(buildSpec("Ryzen 7 5800X3D", { generic: true }).query, "ryzen 7 5800x3d");
  const i5 = buildSpec("Intel Core i5-12400F", { generic: true });
  assert.equal(i5.query, "i5 12400f");
  assert.ok(!ok("Intel Core i5-12400 com vídeo integrado", i5));
});

test("RAM e SSD", () => {
  assert.equal(coreModel("Memória Kingston Fury DDR4 16GB 3200MHz").query, "ddr4 16gb");
  assert.equal(coreModel("SSD NVMe Kingston 1TB M.2").query, "ssd nvme 1tb");
});

test("'sem defeito' é aceito; defeito de verdade, peças e acessórios não", () => {
  assert.ok(ok("RTX 4060 8GB perfeita, sem defeito"));
  assert.ok(ok("RTX 4060 8GB com garantia contra defeitos"));
  assert.ok(!ok("RTX 4060 8GB com defeito"));
  assert.ok(!ok("RTX 4060 8GB para retirada de peças"));
  assert.ok(!ok("Suporte Anti Sag para RTX 4060 8GB"));
});

test("PCs e notebooks completos ficam de fora quando o modelo é reconhecido", () => {
  assert.ok(!ok("Notebook Gamer Acer Nitro RTX 4060 16GB"));
  assert.ok(!ok("PC Gamer Ryzen 5 RTX 4060 16GB"));
});

test("busca exata exige proporção mínima de palavras", () => {
  const exact = buildSpec("Monitor LG UltraGear 27 144hz", { generic: false });
  assert.ok(relevant({ title: "Monitor Gamer LG UltraGear 27 Polegadas 144hz", price: 1 }, exact));
  assert.ok(!relevant({ title: "Cadeira Gamer Preta", price: 1 }, exact));
});

test("detectBrand", () => {
  assert.equal(detectBrand("Placa De Vídeo Gigabyte Geforce RTX 4060"), "Gigabyte");
  assert.equal(detectBrand("Placa genérica"), "");
});

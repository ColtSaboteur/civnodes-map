(() => {
  const DEFAULT_LEGEND = {
    "█": { name: "Nodes", color: "#ff5470" },
    "▓": { name: "Nodes", color: "#4fb3ff" },
    "▒": { name: "Nodes", color: "#f5c451" },
    "#": { name: "No node", color: "#9b6bff" }
  };
  let legend = structuredClone(DEFAULT_LEGEND);
  let SQL;

  const mapStatus = document.getElementById("map-status");
  const mapCoordinates = document.getElementById("map-coordinates");
  const claimsStatus = document.getElementById("claims-status");
  const settlementsStatus = document.getElementById("settlements-status");
  const nodeStatus = document.getElementById("node-status");
  const snitchStatus = document.getElementById("snitch-status");
  const setStatus = (element, text, error = false) => {
    element.textContent = text;
    element.classList.toggle("error", error);
  };
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const sidebarIcon = document.getElementById("sidebar-toggle-icon");
  const sidebarLabel = document.getElementById("sidebar-toggle-label");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");
  const mapShell = document.querySelector(".map-shell");
  const mobileLayout = window.matchMedia("(max-width: 760px)");
  const setSidebarOpen = (open) => {
    sidebar.classList.toggle("collapsed", !open);
    sidebar.inert = !open;
    sidebarToggle.setAttribute("aria-expanded", String(open));
    sidebarToggle.setAttribute("aria-label", open ? "Hide map controls" : "Show map controls");
    sidebarIcon.textContent = mobileLayout.matches ? (open ? "×" : "☰") : (open ? "‹" : "›");
    sidebarLabel.textContent = open ? "Close" : "Menu";
    sidebarBackdrop.hidden = !mobileLayout.matches || !open;
    mapShell.inert = mobileLayout.matches && open;
    if (!open && sidebar.contains(document.activeElement)) sidebarToggle.focus();
  };
  sidebarToggle.addEventListener("click", () => setSidebarOpen(sidebar.classList.contains("collapsed")));
  sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("photosphere-dialog").open) setSidebarOpen(false);
  });
  mobileLayout.addEventListener("change", () => setSidebarOpen(!mobileLayout.matches));
  setSidebarOpen(!mobileLayout.matches);
  [["node-help", "node-info"], ["snitch-help", "snitch-info"]].forEach(([buttonId, boxId]) => {
    const button = document.getElementById(buttonId);
    const box = document.getElementById(boxId);
    button.addEventListener("click", () => {
      box.hidden = !box.hidden;
      button.setAttribute("aria-expanded", String(!box.hidden));
    });
  });
  const getJson = async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  })[character]);

  const worldCrs = ({ minX, minZ, size }) => {
    return L.Util.extend({}, L.CRS.Simple, {
      projection: {
        bounds: L.bounds([0, 0], [1, 1]),
        project: ({ lat, lng }) => L.point((lng - minX) / size, (lat - minZ) / size),
        unproject: ({ x, y }) => L.latLng(minZ + y * size, minX + x * size)
      },
      transformation: new L.Transformation(1, 0, 1, 0),
      scale: (zoom) => 256 * 2 ** zoom,
      zoom: (scale) => Math.log2(scale / 256),
      infinite: false
    });
  };

  const renderLegend = () => {
    const container = document.getElementById("node-legend");
    container.replaceChildren(...Object.entries(legend).map(([symbol, { name, color }]) => {
      const row = document.createElement("div");
      row.className = "legend-row";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = color;
      row.append(swatch, document.createTextNode(`${symbol} ${name}`));
      return row;
    }));
  };

  const setLayerToggle = (id, layer, map, onVisibility = () => {}) => {
    const control = document.getElementById(id);
    control.disabled = false;
    if (control.checked) layer.addTo(map);
    onVisibility(control.checked);
    control.onchange = ({ target }) => {
      target.checked ? layer.addTo(map) : map.removeLayer(layer);
      onVisibility(target.checked);
    };
  };

  const opacityControl = (inputId, outputId, apply) => {
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    const update = () => {
      const opacity = Number(input.value) / 100;
      output.textContent = `${input.value}%`;
      apply(opacity);
    };
    input.addEventListener("input", update);
    return { input, update, value: () => Number(input.value) / 100 };
  };

  const nodeEntries = (data) => {
    if (Array.isArray(data)) return data.map((node) => [node.cx ?? node[0], node.cz ?? node[1], node.type ?? node[2] ?? "#"]);
    if (Array.isArray(data.nodes)) return nodeEntries(data.nodes);
    if (data.nodes && typeof data.nodes === "object") return Object.entries(data.nodes).map(([key, type]) => [...key.split(",").map(Number), type]);
    return [];
  };

  const readFile = (file, mode) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    mode === "text" ? reader.readAsText(file) : reader.readAsArrayBuffer(file);
  });

  const loadSql = async () => {
    if (SQL) return SQL;
    if (!window.initSqlJs) throw new Error("the SQLite reader could not load");
    SQL = await window.initSqlJs({ locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` });
    return SQL;
  };

  const snitchColor = (snitch) => {
    let timestamp = Number(snitch.dormantTs || snitch.cullTs);
    if (!timestamp) return "#73e6aa";
    if (timestamp < 1e11) timestamp *= 1000;
    const days = (timestamp - Date.now()) / 86_400_000;
    return days < 2 ? "#ff5470" : days < 7 ? "#f5c451" : "#73e6aa";
  };

  const normalizeSnitches = (rows) => rows.map((row) => ({
    x: Number(row.x ?? row["х"]), y: Number(row.y ?? 60), z: Number(row.z),
    name: row.name || "", group: row.group_name || row.group || "", type: row.type || "Snitch",
    dormantTs: row.dormant_ts || row.dormantTs, cullTs: row.cull_ts || row.cullTs
  })).filter(({ x, z }) => Number.isFinite(x) && Number.isFinite(z));

  const settlementEntries = (data) => (Array.isArray(data) ? data : data.settlements || []).map((settlement) => {
    const coordinates = settlement.coordinates || settlement;
    return {
      name: String(settlement.name || "").trim(),
      x: Number(coordinates.x), z: Number(coordinates.z),
      nation: String(settlement.nation || "").trim(),
      contact: String(settlement.contact || "").trim(),
      visitors: String(settlement.visitors || "").trim(),
      discord: String(settlement.discord || "").trim()
    };
  }).filter(({ name, x, z }) => name && Number.isFinite(x) && Number.isFinite(z));

  const settlementDiscord = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  };

  const settlementPopup = ({ name, x, z, nation, contact, visitors, discord }) => {
    const details = [
      ["Nation", nation], ["Contact", contact], ["Visitors", visitors], ["Coordinates", `X ${x}, Z ${z}`]
    ].filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("");
    const discordUrl = settlementDiscord(discord);
    const discordLink = discordUrl ? `<p><a href="${escapeHtml(discordUrl)}" target="_blank" rel="noopener noreferrer">Settlement Discord</a></p>` : "";
    return `<h2>${escapeHtml(name)}</h2><dl>${details}</dl>${discordLink}`;
  };

  const photosphereDialog = document.getElementById("photosphere-dialog");
  const photosphereStatus = document.getElementById("photosphere-status");
  let photosphereLibrary;
  let photosphereViewer;
  let photosphereTrigger;
  let photosphereRequest = 0;

  const loadPhotosphereLibrary = () => {
    if (!photosphereLibrary) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://cdn.jsdelivr.net/npm/pannellum@2.5.7/build/pannellum.css";
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/pannellum@2.5.7/build/pannellum.js";
      photosphereLibrary = Promise.all([css, script].map((element) => new Promise((resolve, reject) => {
        element.onload = resolve;
        element.onerror = () => reject(new Error("The 360° viewer could not load. Close and try again."));
        document.head.append(element);
      }))).catch((error) => {
        css.remove();
        script.remove();
        photosphereLibrary = undefined;
        throw error;
      });
    }
    return photosphereLibrary;
  };

  document.getElementById("photosphere-close").addEventListener("click", () => photosphereDialog.close());
  // Pannellum consumes Escape before the browser can dismiss the dialog.
  photosphereDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      photosphereDialog.close();
    }
  }, true);
  photosphereDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    photosphereDialog.close();
  });
  photosphereDialog.addEventListener("close", () => {
    photosphereRequest++;
    photosphereViewer?.destroy();
    photosphereViewer = undefined;
    document.getElementById("photosphere-viewer").replaceChildren();
    photosphereTrigger?.focus({ preventScroll: true });
  });

  const openPhotosphere = async (panorama, trigger) => {
    const request = ++photosphereRequest;
    photosphereTrigger = trigger;
    document.getElementById("photosphere-title").textContent = panorama.name;
    document.getElementById("photosphere-coordinates").textContent = `X ${panorama.coordinates.x}, Z ${panorama.coordinates.z}`;
    document.getElementById("photosphere-upload-date").textContent = panorama.uploadedAt ? `Uploaded ${panorama.uploadedAt}` : "Upload date unavailable";
    setStatus(photosphereStatus, "Loading 360° view.");
    photosphereDialog.showModal();
    try {
      await loadPhotosphereLibrary();
      if (!photosphereDialog.open || request !== photosphereRequest) return;
      photosphereViewer = window.pannellum.viewer("photosphere-viewer", {
        type: "cubemap", cubeMap: panorama.faces, autoLoad: true,
        autoRotate: 0, compass: false, showFullscreenCtrl: false,
        strings: { loadingLabel: "Loading photosphere…" }
      });
      [[".pnlm-zoom-in", "Zoom in"], [".pnlm-zoom-out", "Zoom out"]].forEach(([selector, label]) => {
        const control = document.querySelector(`#photosphere-viewer ${selector}`);
        control.setAttribute("role", "button");
        control.setAttribute("aria-label", label);
        control.tabIndex = 0;
        control.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            control.click();
          }
        };
      });
      photosphereViewer.on("load", () => {
        if (request === photosphereRequest) setStatus(photosphereStatus, "Drag or swipe to look around. Use + / − to zoom; focus the view to use arrow keys.");
      });
      photosphereViewer.on("error", () => {
        if (request === photosphereRequest) setStatus(photosphereStatus, "This photosphere could not load. Close and try again.", true);
      });
    } catch (error) {
      if (photosphereDialog.open && request === photosphereRequest) setStatus(photosphereStatus, error.message, true);
    }
  };

  const photosphereEntries = (data) => {
    if (!Array.isArray(data.panoramas)) throw new Error("The photospheres list is invalid.");
    const base = new URL("panoramas/", document.baseURI);
    const ids = new Set();
    return data.panoramas.map((panorama) => {
      if (!panorama || typeof panorama.id !== "string" || !panorama.id.trim() || ids.has(panorama.id)
        || typeof panorama.name !== "string" || !panorama.name.trim()
        || !Number.isFinite(panorama.coordinates?.x) || !Number.isFinite(panorama.coordinates?.z)
        || !Array.isArray(panorama.faces) || panorama.faces.length !== 6) {
        throw new Error("A photosphere has invalid details or coordinates.");
      }
      ids.add(panorama.id);
      if (panorama.uploadedAt !== undefined && (typeof panorama.uploadedAt !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(panorama.uploadedAt)
        || !Number.isFinite(Date.parse(panorama.uploadedAt))
        || new Date(panorama.uploadedAt).toISOString().slice(0, 10) !== panorama.uploadedAt)) {
        throw new Error("A photosphere upload date must use YYYY-MM-DD.");
      }
      const faces = panorama.faces.map((face) => {
        if (typeof face !== "string" || !face.trim() || face.startsWith("/")) throw new Error("A photosphere image path is invalid.");
        const url = new URL(face, base);
        if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("Photosphere images must be inside the panoramas folder.");
        return url.href;
      });
      return { ...panorama, faces };
    });
  };

  async function start() {
    let config;
    try {
      config = await getJson("map-data/api/config.json");
    } catch (error) {
      setStatus(mapStatus, `Map configuration could not load. ${error.message}`, true);
      return;
    }
    const settings = config.tileSettings;
    if (!settings?.worldBounds || !Number.isFinite(settings.worldBounds.size)) {
      setStatus(mapStatus, "Map configuration has no generated world bounds. Run the updater first.", true);
      return;
    }

    renderLegend();
    const world = settings.worldBounds;
    const bounds = L.latLngBounds([world.minZ, world.minX], [world.minZ + world.size, world.minX + world.size]);
    const map = L.map("map", { attributionControl: false, crs: worldCrs(world), keyboard: false, minZoom: settings.minZoom, maxZoom: settings.maxZoom, maxBounds: bounds });
    new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(map.getContainer());
    L.tileLayer("map-data/tiles/{z}/{x}/{y}.png", {
      minZoom: settings.minZoom, maxZoom: settings.maxZoom, tileSize: settings.tileSize, noWrap: true, bounds
    }).on("tileerror", () => setStatus(mapStatus, "A map tile could not load. Run the updater again and republish site/.", true)).addTo(map);
    map.fitBounds(bounds, { padding: [16, 16] });
    map.on("mousemove", ({ latlng }) => {
      const x = Math.floor(latlng.lng);
      const z = Math.floor(latlng.lat);
      mapCoordinates.textContent = `X ${x}, Z ${z} · Chunk ${Math.floor(x / 16)}, ${Math.floor(z / 16)}`;
    });

    document.getElementById("jump-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const x = Number(document.getElementById("jump-x").value);
      const z = Number(document.getElementById("jump-z").value);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return setStatus(mapStatus, "Enter numeric X and Z coordinates.", true);
      map.setView([z, x], Math.max(map.getZoom(), settings.maxZoom - 1));
      setStatus(mapStatus, `Centered on X ${x}, Z ${z}.`);
    });

    const claimsToggle = document.getElementById("claims-toggle");
    const claims = L.imageOverlay("images/claims.png", bounds, { opacity: .7 });
    const claimsOpacity = opacityControl("claims-opacity", "claims-opacity-value", (opacity) => claims.setOpacity(opacity));
    claimsOpacity.update();
    claims.on("load", () => {
      setStatus(claimsStatus, "");
    }).on("error", () => {
      claimsToggle.disabled = true;
      setStatus(claimsStatus, "Claims image could not load. Publish site/images/claims.png.", true);
    });
    claimsToggle.addEventListener("change", ({ target }) => target.checked ? claims.addTo(map) : map.removeLayer(claims));

    const settlementsToggle = document.getElementById("settlements-toggle");
    try {
      const data = await getJson("api/settlements.json");
      const settlements = settlementEntries(data);
      const layer = L.layerGroup(settlements.map((settlement) => L.circleMarker([settlement.z, settlement.x], {
        radius: 5, color: "var(--cyan)", weight: 2, fillColor: "var(--cyan-dim)", fillOpacity: 1
      }).bindTooltip(escapeHtml(settlement.name), {
        permanent: true, direction: "top", offset: [0, -4], className: "settlement-label"
      }).bindPopup(settlementPopup(settlement))));
      setLayerToggle("settlements-toggle", layer, map);
      setStatus(settlementsStatus, "");
    } catch (error) {
      settlementsToggle.disabled = true;
      setStatus(settlementsStatus, `Settlements could not load. ${error.message}`, true);
    }

    const photospheresStatus = document.getElementById("photospheres-status");
    try {
      const panoramas = photosphereEntries(await getJson("panoramas/panoramas.json"));
      const icon = L.divIcon({
        className: "photosphere-marker", iconSize: [44, 44], iconAnchor: [22, 22],
        html: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 6h4l2-3h6l2 3h4v15H3Z"/><circle cx="12" cy="13" r="4"/></svg>'
      });
      const layer = L.layerGroup(panoramas.map((panorama) => {
        const marker = L.marker([panorama.coordinates.z, panorama.coordinates.x], {
          icon, title: panorama.name, keyboard: true, autoPanOnFocus: false
        }).bindTooltip(escapeHtml(panorama.name));
        marker.on("add", () => {
          const element = marker.getElement();
          element.setAttribute("aria-label", panorama.name);
          element.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              marker.fire("click");
            }
          };
        });
        return marker.on("click", () => openPhotosphere(panorama, marker.getElement()));
      }));
      setLayerToggle("photospheres-toggle", layer, map);
      setStatus(photospheresStatus, panoramas.length ? "" : "No photospheres have been added yet.");
    } catch (error) {
      document.getElementById("photospheres-toggle").disabled = true;
      setStatus(photospheresStatus, `Photospheres could not load. ${error.message}`, true);
    }

    const nodes = L.layerGroup();
    const nodesOpacity = opacityControl("nodes-opacity", "nodes-opacity-value", (opacity) => nodes.eachLayer((layer) => layer.setStyle({ fillOpacity: opacity })));
    document.getElementById("node-file").addEventListener("change", async ({ target }) => {
      const [file] = target.files;
      if (!file) return;
      try {
        const data = JSON.parse(await readFile(file, "text"));
        if (data.legend && typeof data.legend === "object") {
          Object.keys(legend).forEach((key) => Object.assign(legend[key], data.legend[key] || {}));
          renderLegend();
        }
        nodes.clearLayers();
        const entries = nodeEntries(data).filter(([x, z]) => Number.isFinite(x) && Number.isFinite(z));
        entries.forEach(([chunkX, chunkZ, type]) => {
          const entry = legend[type] || { name: "Unknown", color: "#888888" };
          L.rectangle([[chunkZ * 16, chunkX * 16], [chunkZ * 16 + 16, chunkX * 16 + 16]], {
            color: entry.color, weight: 1, fillColor: entry.color, fillOpacity: nodesOpacity.value()
          }).bindTooltip(`${escapeHtml(entry.name)}<br>Chunk ${chunkX}, ${chunkZ}`).addTo(nodes);
        });
        nodesOpacity.input.disabled = false;
        nodesOpacity.update();
        setLayerToggle("nodes-toggle", nodes, map, (visible) => { document.getElementById("node-legend").hidden = !visible; });
        setStatus(nodeStatus, `Loaded ${file.name} with ${entries.length} chunks.`);
      } catch (error) {
        setStatus(nodeStatus, `Node JSON could not load. ${error.message}`, true);
      }
    });

    const snitches = L.layerGroup();
    const snitchesOpacity = opacityControl("snitches-opacity", "snitches-opacity-value", (opacity) => snitches.eachLayer((layer) => layer.setStyle({ fillOpacity: opacity })));
    document.getElementById("snitch-file").addEventListener("change", async ({ target }) => {
      const [file] = target.files;
      if (!file) return;
      try {
        let parsed;
        if (file.name.toLowerCase().endsWith(".json")) {
          const data = JSON.parse(await readFile(file, "text"));
          parsed = normalizeSnitches(Array.isArray(data) ? data : data.snitches || []);
        } else {
          const database = new (await loadSql()).Database(new Uint8Array(await readFile(file, "arrayBuffer")));
          const result = database.exec("SELECT * FROM snitches_v2")[0];
          if (!result) throw new Error("no snitch records found in snitches_v2");
          parsed = normalizeSnitches(result.values.map((row) => Object.fromEntries(result.columns.map((column, index) => [column.toLowerCase(), row[index]]))));
        }
        snitches.clearLayers();
        parsed.forEach((snitch) => {
          const color = snitchColor(snitch);
          L.rectangle([[snitch.z - 10, snitch.x - 10], [snitch.z + 11, snitch.x + 11]], {
            color, weight: 1, fillColor: color, fillOpacity: snitchesOpacity.value()
          }).bindTooltip(`<strong>${escapeHtml(snitch.name || "Unnamed snitch")}</strong><br>X: ${snitch.x}, Y: ${snitch.y}, Z: ${snitch.z}<br>${escapeHtml(snitch.type)}${snitch.group ? `<br>${escapeHtml(snitch.group)}` : ""}`).addTo(snitches);
        });
        snitchesOpacity.input.disabled = false;
        snitchesOpacity.update();
        setLayerToggle("snitches-toggle", snitches, map);
        setStatus(snitchStatus, `Loaded ${file.name} with ${parsed.length} snitches.`);
      } catch (error) {
        setStatus(snitchStatus, `Snitch data could not load. ${error.message}`, true);
      }
    });
  }

  start();
})();

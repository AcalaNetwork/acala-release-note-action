const fs = require("fs");
const path = require("path");
const core = require("@actions/core");
const handlebars = require("handlebars");
const shell = require("shelljs");
const assert = require("assert");

const silent = false;

const scopes = {
  client: "Client Only",
  runtime: "Runtime Only",
  full: "Full Release",
};

const chains = {
  mandala: "Mandala",
  karura: "Karura",
  acala: "Acala",
};

function findPackage(package_name) {
  const package_info = shell.exec(
    `cargo tree -p ${package_name} --depth=0 -e=normal -i`, { silent }
  ).stdout;
  const [p, version, url] = package_info.split(" ");
  let [, hash] = url.trim().slice(1, -1).split("#");
  assert(hash);
  return [p, version, hash];
}

function getDepsVersions(branch) {
  shell.exec(
    `git switch --detach ${branch} & git submodule update --init --recursive`,
    { silent }
  );

  // find frame-system
  const [, substrate_version, substrate_commit] = findPackage("frame-system");
  core.debug(`${branch}: substrate=${substrate_version} commit=${substrate_commit}`);

  // find polkadot-cli
  const [, polkadot_version, polkadot_commit] = findPackage("polkadot-cli");
  core.debug(`${branch}: polkadot=${polkadot_version} commit=${polkadot_commit}`);

  // find cumulus-client-cli
  const [, cumulus_version, cumulus_commit] = findPackage("cumulus-client-cli");
  core.debug(`${branch}: cumulus=${cumulus_version} commit=${cumulus_commit}`);

  shell.exec(`git switch - & git submodule update --init --recursive`, {
    silent,
  });
  return { substrate_version, substrate_commit, polkadot_version, polkadot_commit, cumulus_version, cumulus_commit };
}

function getSubmoduleVersion(submodule, branch) {
  // something like: 160000 commit 37e42936c41dbdbaf0117c628c9eab0e06044844	- orml
  const output = shell
    .exec(`git ls-tree -l ${branch} ${submodule}`, { silent })
    .stdout.trim();
  const matches = output.match(/([\w+]+)/g);
  assert(
    matches && matches.length > 2,
    `Can't find ${submodule} version for branch: ${branch}`
  );
  const commit = matches[2].slice(0, 8);
  core.debug(`${branch}: ${submodule}=${commit}`);
  return commit;
}

function getRuntimeVersion(branch, chain) {
  const spec_version = shell
    .exec(`git show ${branch}:runtime/${chain}/src/lib.rs | grep spec_version`, {
      silent,
    })
    .stdout.trim()
    .split(" ");
  assert(spec_version.length === 2, "Cant't find runtime version");
  const runtime = spec_version[1];
  core.debug(`${branch}: runtime=${runtime}`);
  return runtime;
}

// get last 2 branches matching `release-{chain}-*`
function getBranches(chain) {
  return shell
    .exec(`git branch -a | grep release-${chain}-`, { silent })
    .stdout.split("\n")
    .filter((x) => x.trim().length !== 0)
    .slice(-2);
}

function getName(branch) {
  const items = branch.split('/');
  return items[items.length - 1];
}

function getTag(branch) {
  return shell.exec(`git describe --tags --abbrev=0 ${branch}`, { silent }).stdout.trim();
}

async function run() {
  try {
    const scope = core.getInput("scope");
    assert(["client", "runtime", "full"].includes(scope), "Unknown scope");

    const chain = core.getInput("chain");
    assert(["mandala", "karura", "acala"].includes(chain), "Unknown chain");

    const srtool_details_path = core.getInput("srtool_details");
    const subwasm_info_path = core.getInput("subwasm_info");
    const wasm_diff_path = core.getInput("wasm_diff");
    const srtool_details = fs.readFileSync(srtool_details_path, "utf-8");
    const subwasm_info = fs.readFileSync(subwasm_info_path, "utf-8");
    const wasm_diff = fs.readFileSync(wasm_diff_path, "utf-8");

    let templatePath = core.getInput("template");
    if (!templatePath) {
      templatePath = path.join(__dirname, '../release-template.hbs');
    }
    const templateStr = fs.readFileSync(templatePath, "utf-8");

    shell.exec('git fetch origin', { silent });

    const [previous_branch, new_branch] = getBranches(chain);
    core.debug("Previus branch: " + previous_branch);
    core.debug("New branch: " + new_branch);

    const {
      substrate_version,
      substrate_commit,
      polkadot_version,
      polkadot_commit,
      cumulus_version,
      cumulus_commit,
    } = getDepsVersions(new_branch);

    const {
      substrate_commit: previous_substrate_commit,
      polkadot_commit: previous_polkadot_commit,
      cumulus_commit: previous_cumulus_commit,
    } = getDepsVersions(previous_branch);

    const orml_version = getSubmoduleVersion("orml", new_branch);
    const previous_orml_version = getSubmoduleVersion("orml", previous_branch);

    const runtime = getRuntimeVersion(new_branch, chain);
    const previous_runtime = getRuntimeVersion(previous_branch, chain);

    const data = {
      scope: scopes[scope],
      network: chains[chain],
      version: getTag(new_branch),
      previous_version: getTag(previous_branch),
      new_branch: getName(new_branch),
      previous_branch: getName(previous_branch),
      runtime,
      previous_runtime,
      substrate_version,
      substrate_commit,
      previous_substrate_commit,
      polkadot_version,
      polkadot_commit,
      previous_polkadot_commit,
      cumulus_version,
      cumulus_commit,
      previous_cumulus_commit,
      orml_version,
      previous_orml_version,
      srtool_details,
      subwasm_info,
      wasm_diff,
      client_checklist: scope === "client" || scope === "full",
      runtime_checklist: scope === "runtime" || scope === "full",
      is_mandala: chain === "mandala",
      is_karura: chain === "karura",
      is_acala: chain === "acala",
      env: process.env,
    };

    const template = handlebars.compile(templateStr);
    const output = template(data);

    core.setOutput("release-note", output);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();

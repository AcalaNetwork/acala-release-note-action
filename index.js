const fs = require("fs");
const path = require("path");
const core = require("@actions/core");
const github = require("@actions/github");
const handlebars = require("handlebars");
const shell = require("shelljs");
const assert = require("assert");

const silent = false;

const scopes = {
  client: "Client Only",
  runtime: "Runtime Only",
  full: "Full Release",
};

const networks = {
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

function getDepsVersions(tag) {
  shell.exec(
    `git switch --detach ${tag} & git submodule update --init --recursive`,
    { silent }
  );

  // find frame-system
  const [, substrate_version, substrate_commit] = findPackage("frame-system");
  core.debug(`${tag}: substrate=${substrate_version} commit=${substrate_commit}`);

  // find polkadot-cli
  const [, polkadot_version, polkadot_commit] = findPackage("polkadot-cli");
  core.debug(`${tag}: polkadot=${polkadot_version} commit=${polkadot_commit}`);

  // find cumulus-client-cli
  const [, cumulus_version, cumulus_commit] = findPackage("cumulus-client-cli");
  core.debug(`${tag}: cumulus=${cumulus_version} commit=${cumulus_commit}`);

  shell.exec(`git switch - & git submodule update --init --recursive`, {
    silent,
  });
  return { substrate_version, substrate_commit, polkadot_version, polkadot_commit, cumulus_version, cumulus_commit };
}

function getSubmoduleVersion(submodule, tag) {
  // something like: 160000 commit 37e42936c41dbdbaf0117c628c9eab0e06044844	- orml
  const output = shell
    .exec(`git ls-tree -l ${tag} ${submodule}`, { silent })
    .stdout.trim();
  const matches = output.match(/([\w+]+)/g);
  assert(
    matches && matches.length > 2,
    `Can't find ${submodule} version for tag: ${tag}`
  );
  const commit = matches[2].slice(0, 8);
  core.debug(`${tag}: ${submodule}=${commit}`);
  return commit;
}

function getRuntimeVersion(tag, network) {
  const spec_version = shell
    .exec(`git show ${tag}:runtime/${network}/src/lib.rs | grep spec_version`, {
      silent,
    })
    .stdout.trim()
    .split(" ");
  assert(spec_version.length === 2, "Cant't find runtime version");
  const runtime = spec_version[1];
  core.debug(`${tag}: runtime=${runtime}`);
  return runtime;
}

// get last 2 branches matching `release-{network}-*`
function getBranches(network) {
  return shell
    .exec(`git branch -a | grep release-${network}-`, { silent })
    .stdout.split("\n")
    .filter((x) => x.trim().length !== 0)
    .slice(-2);
}

async function run() {
  try {
    core.debug(github);

    const scope = core.getInput("scope");
    assert(["client", "runtime", "full"].includes(scope), "Unknown scope");

    const network = core.getInput("network");
    assert(["mandala", "karura", "acala"].includes(network), "Unknown network");


    const srtool_details_path = core.getInput("srtool_details");
    const subwasm_info_path = core.getInput("subwasm_info");

    const version = core.getInput("tag");
    const previous_version = core.getInput("previous_tag");
    assert(version, "Tag missing");
    assert(previous_version, "Previous tag missing");

    const srtool_details = fs.readFileSync(srtool_details_path, "utf-8");
    const subwasm_info = fs.readFileSync(subwasm_info_path, "utf-8");

    const templatePath = core.getInput("template");
    const templateStr = fs.readFileSync(templatePath, "utf-8");

    const {
      substrate_version,
      substrate_commit,
      polkadot_version,
      polkadot_commit,
      cumulus_version,
      cumulus_commit,
    } = getDepsVersions(version);

    const {
      substrate_commit: previous_substrate_commit,
      polkadot_commit: previous_polkadot_commit,
      cumulus_commit: previous_cumulus_commit,
    } = getDepsVersions(previous_version);

    const orml_version = getSubmoduleVersion("orml", version);
    const previous_orml_version = getSubmoduleVersion("orml", previous_version);

    const runtime = getRuntimeVersion(version, network);
    const previous_runtime = getRuntimeVersion(previous_version, network);

    const data = {
      scope: scopes[scope],
      network: networks[network],
      version,
      previous_version,
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
      client_checklist: scope === "client" || scope === "full",
      runtime_checklist: scope === "runtime" || scope === "full",
      is_mandala: network === "mandala",
      is_karura: network === "karura",
      is_acala: network === "acala",
    };

    const template = handlebars.compile(templateStr);
    const output = template(data);

    const outputPath = path.format({
      ...path.parse(templatePath),
      base: undefined,
      ext: ".md",
    });
    fs.writeFileSync(outputPath, output);
    core.setOutput("release-note", outputPath);
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();

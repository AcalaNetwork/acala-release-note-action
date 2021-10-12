const fs = require("fs");
const path = require("path");
const core = require("@actions/core");
const github = require("@actions/github");
const handlebars = require("handlebars");
const shell = require("shelljs");
const assert = require("assert");

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
    `cargo tree -p ${package_name} --depth=0 -e=normal -i`
  ).stdout;
  const [p, version, url] = package_info.split(" ");
  let [, hash] = url.trim().slice(1, -1).split("#");
  assert(hash);
  return [p, version, hash];
}

function getDepsVersions(tag) {
  shell.exec(
    `git switch --detach ${tag} & git submodule update --init --recursive`,
    { silent: true }
  );

  // find frame-system
  const [, , substrateRev] = findPackage("frame-system");
  core.debug(`${tag}: substrate=${substrateRev}`);

  // find polkadot-cli
  const [, , polkadotRev] = findPackage("polkadot-cli");
  core.debug(`${tag}: polkadot=${polkadotRev}`);

  // find cumulus-client-cli
  const [, , cumulusRev] = findPackage("cumulus-client-cli");
  core.debug(`${tag}: cumulus=${cumulusRev}`);

  shell.exec(`git switch - & git submodule update --init --recursive`, {
    silent: true,
  });
  return { substrateRev, polkadotRev, cumulusRev };
}

function getSubmoduleVersion(submodule, tag) {
  const output = shell
    .exec(`git ls-tree ${tag} ${submodule}`, { silent: true })
    .stdout.trim();
  const matches = output.match(/([\w+]+)/g);
  assert(
    matches && matches.length > 2,
    `Can't find ${submodule} version for tag: ${tag}`
  );
  const version = matches[2];
  core.debug(`${tag}: ${submodule}=${version}`);
  return version;
}

function getRuntimeVersion(tag) {
  const spec_version = shell
    .exec(`git show ${tag}:runtime/karura/src/lib.rs | grep spec_version`, {
      silent: true,
    })
    .stdout.trim()
    .split(" ");
  assert(spec_version.length === 2, "Cant't find runtime version");
  const runtime = spec_version[1];
  core.debug(`${tag}: runtime=${runtime}`);
  return runtime;
}

function getBranches(network) {
  return shell
    .exec(`git branch -a | grep release-${network}-`, { silent: true })
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

    const templatePath = core.getInput("template");
    const templateStr = fs.readFileSync(templatePath, "utf-8");

    const [previous_branch, new_branch] = getBranches(network);
    core.debug(`new_branch = ${new_branch}`);
    core.debug(`previous_branch = ${previous_branch}`);

    const version = shell
      .exec(`git describe --abbrev=0 --tags ${new_branch}`, { silent: true })
      .stdout.trim();
    assert(version, "Can't find tag");
    const previous_version = shell
      .exec(`git describe --abbrev=0 --tags ${previous_branch}`, {
        silent: true,
      })
      .stdout.trim();
    assert(previous_version, "Can't find previous tag");

    const branch_name = new_branch.split("/")[2];
    const previous_branch_name = previous_branch.split("/")[2];

    const {
      substrateRev: substrate_version,
      polkadotRev: polkadot_version,
      cumulusRev: cumulus_version,
    } = getDepsVersions(version);

    const {
      substrateRev: previous_substrate_version,
      polkadotRev: previous_polkadot_version,
      cumulusRev: previous_cumulus_version,
    } = getDepsVersions(previous_version);

    const orml_version = getSubmoduleVersion("orml", version);
    const previous_orml_version = getSubmoduleVersion("orml", previous_version);

    const runtime = getRuntimeVersion(version);
    const previous_runtime = getRuntimeVersion(previous_version);

    const srtool_details_path = core.getInput("srtool_details");
    const subwasm_info_path = core.getInput("subwasm_info");

    const srtool_details = fs.readFileSync(srtool_details_path, "utf-8");
    const subwasm_info = fs.readFileSync(subwasm_info_path, "utf-8");

    const data = {
      scope: scopes[scope],
      network: networks[network],
      version,
      previous_version,
      runtime,
      previous_runtime,
      branch_name,
      previous_branch_name,
      substrate_version,
      previous_substrate_version,
      polkadot_version,
      previous_polkadot_version,
      cumulus_version,
      previous_cumulus_version,
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

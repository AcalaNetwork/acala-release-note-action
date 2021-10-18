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

function getRuntimeVersion(tag, chain) {
  const spec_version = shell
    .exec(`git show ${tag}:runtime/${chain}/src/lib.rs | grep spec_version`, {
      silent,
    })
    .stdout.trim()
    .split(" ");
  assert(spec_version.length === 2, "Cant't find runtime version");
  const runtime = spec_version[1];
  core.debug(`${tag}: runtime=${runtime}`);
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

async function run() {
  try {
    core.debug(github);

    const scope = core.getInput("scope");
    assert(["client", "runtime", "full"].includes(scope), "Unknown scope");

    const chain = core.getInput("chain");
    assert(["mandala", "karura", "acala"].includes(chain), "Unknown chain");

    const version = core.getInput("tag");
    const previous_version = core.getInput("previous_tag");
    assert(version, "Tag missing");
    assert(previous_version, "Previous tag missing");

    let templatePath = core.getInput("template");
    if (!templatePath) {
      templatePath = path.join(__dirname, '../release-template.hbs');
    }
    const templateStr = fs.readFileSync(templatePath, "utf-8");

    shell.exec('git fetch --tags', { silent });

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

    const runtime = getRuntimeVersion(version, chain);
    const previous_runtime = getRuntimeVersion(previous_version, chain);

    const data = {
      scope: scopes[scope],
      network: chains[chain],
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

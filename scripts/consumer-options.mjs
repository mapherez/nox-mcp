// CI uses explicit environment selection to avoid npm/PowerShell swallowing
// forwarding flags. Preserve the documented local CLI flags, rejecting conflicts.
export function consumerProfile(args, env) {
  const profile=env.NOX_CONSUMER_PROFILE??(args.includes('--minimum')?'minimum':'latest');
  if(!['minimum','latest'].includes(profile))throw Error(`Invalid consumer profile: ${profile}`);
  if(args.includes('--minimum')&&profile!=='minimum')throw Error('Conflicting consumer profiles');
  return profile;
}
export function consumerOptions(args=process.argv.slice(2),env=process.env) {
  if(args.some(arg=>arg!=='--minimum'&&!/^--language=(all|go|rust)$/.test(arg)))throw Error('Usage: --language=go|rust|all [--minimum]');
  const argument=args.find(arg=>arg.startsWith('--language='))?.slice(11);
  const language=env.NOX_CONSUMER_LANGUAGE??argument??'all';
  if(!['all','go','rust'].includes(language))throw Error(`Invalid consumer language: ${language}`);
  if(argument&&argument!==language)throw Error('Conflicting consumer languages');
  if((env.NOX_CONSUMER_LANGUAGE!==undefined||env.NOX_CONSUMER_PROFILE!==undefined)&&
     (!['go','rust'].includes(env.NOX_CONSUMER_LANGUAGE)||env.NOX_CONSUMER_PROFILE===undefined))throw Error('CI consumer selection requires one language and an explicit profile');
  const profile=consumerProfile(args,env);
  return {language,profile,minimum:profile==='minimum'};
}
